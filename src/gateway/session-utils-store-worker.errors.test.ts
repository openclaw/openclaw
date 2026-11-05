import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  readSessionStoreTargetInventory,
  type SessionStoreTargetInventoryRequest,
} from "../config/sessions/session-store-target-inventory.js";
import { formatErrorMessageForDisplay } from "../infra/error-diagnostics.js";
import * as agentDatabase from "../state/openclaw-agent-db-readonly.js";
import { errorShapeFromError } from "./error-shape.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";

// mock-isolation: Run real discovery inline, cloning its result like the worker transport.
vi.mock("../config/sessions/session-store-target-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/session-store-target-runtime.js")>()),
  prepareSessionStoreTargetInventoryRead: (request: SessionStoreTargetInventoryRequest) => ({
    withRead: async <T>(operation: (inventory: unknown, assertCurrent: () => void) => Promise<T>) =>
      operation(
        structuredClone(readSessionStoreTargetInventory({ ...request, registeredDatabases: [] })),
        () => {},
      ),
  }),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([
  { reason: "schema-missing", failure: undefined, suffix: "" },
  {
    reason: "read-failed",
    failure: Object.assign(new Error("cannot read /private/fixture/secret.sqlite"), {
      name: "SqliteError",
      code: "SQLITE_IOERR",
    }),
    suffix: ": SQLITE_IOERR",
  },
  {
    reason: "read-failed",
    failure: "cannot read /private/fixture/other.sqlite",
    suffix: ": Error",
  },
  {
    reason: "read-failed",
    failure: Object.assign(new Error("cannot read /private/fixture/secret.sqlite"), {
      name: "/private/fixture/unsafe.sqlite",
      code: "/private/fixture/unsafe.sqlite",
    }),
    suffix: "",
  },
] as const)(
  "preserves $reason diagnostics without exposing native text to clients",
  async ({ reason, failure, suffix }) => {
    const root = tempDirs.make("session-unavailable-");
    const storePath = path.join(root, "sessions.sqlite");
    fs.writeFileSync(storePath, "");
    vi.spyOn(agentDatabase, "withOpenClawAgentDatabaseReadOnly").mockImplementation(() => {
      if (failure !== undefined) {
        // oxlint-disable-next-line typescript/only-throw-error -- Verify diagnostics for native non-Error throws.
        throw failure;
      }
      return { found: false, reason: "schema-missing" };
    });

    const error = await loadGatewaySessionEntryReadOnlyInWorker({
      cfg: { session: { store: storePath } },
      key: "agent:main:main",
      env: { OPENCLAW_STATE_DIR: root },
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "SessionStoreUnavailableError", reason });
    const message = `Session stores for agent main are unavailable (${reason}${suffix}); retry after storage is available.`;
    const response = errorShapeFromError(ErrorCodes.UNAVAILABLE, error);
    expect(response).toEqual({ code: "UNAVAILABLE", message });
    expect(JSON.stringify(response)).not.toContain(".sqlite");
    expect(JSON.stringify(response)).not.toContain(root);
    if (failure !== undefined) {
      const nativeMessage = typeof failure === "string" ? failure : failure.message;
      expect(error).toMatchObject({ readError: { message: nativeMessage } });
      expect(formatErrorMessageForDisplay(response)).toContain(nativeMessage);
      if (typeof failure !== "string") {
        expect(error).toMatchObject({ readError: { name: failure.name, code: failure.code } });
        expect(formatErrorMessageForDisplay(response)).toContain(failure.name);
        expect(formatErrorMessageForDisplay(response)).toContain(failure.code);
      }
    }
  },
);
