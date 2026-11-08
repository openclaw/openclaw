import fs from "node:fs/promises";
import { StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { dispatchAuthorizationRequest } from "./server-methods.authorization.test-support.js";
import { sessionsFilesHandlers } from "./server-methods/sessions-files.js";
import type { GatewayClient, GatewayRequestHandlers } from "./server-methods/types.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { roleClient, rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

afterEach(() => vi.restoreAllMocks());

const target = { agentId: "main", sessionKey: "agent:main:file-turn", sessionId: "file-turn" };
const fileContent = "<p>Private host file</p>";

async function hostFile(state: OpenClawTestState) {
  const filePath = state.path("outside.html");
  await fs.writeFile(filePath, fileContent);
  return { sessionRoot: state.workspaceDir, filePath };
}

function expectFile(payload: unknown, fields: Record<string, unknown> = {}) {
  expect(payload).toMatchObject({ file: { content: fileContent, ...fields } });
  expect(payload).not.toHaveProperty("file.hash");
}

async function fileGateway(cfg: OpenClawConfig = {}, withPlacement = true) {
  const projection = await createSessionRowProjection({ cfg });
  const context = bindSessionRowProjection(
    createDirectChatContext({
      getRuntimeConfig: () => cfg,
      ...(withPlacement
        ? { workerSessionPlacementService: createWorkerSessionPlacementStore() }
        : {}),
    }),
    () => projection,
  );
  return {
    projection,
    context,
    [Symbol.dispose]: () => projection.dispose(),
    async read(
      client: GatewayClient,
      sessionKey: string,
      path: string,
      extraHandlers: GatewayRequestHandlers = sessionsFilesHandlers,
    ) {
      const respond = await dispatchAuthorizationRequest(
        "sessions.files.get",
        { sessionKey, path },
        { client, context, extraHandlers },
        "file-read",
      );
      expect(respond).toHaveBeenCalledOnce();
      return respond;
    },
  };
}

function seedSession(
  selected: typeof target,
  overrides: Partial<Parameters<typeof upsertSessionEntryCore>[1]> = {},
) {
  return upsertSessionEntryCore(selected, {
    sessionId: selected.sessionId,
    updatedAt: 1,
    ...overrides,
  });
}

it("reads host files for a session writer and hides them from view-only callers", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = rolePolicyConfig();
    setRuntimeConfigSnapshot(cfg);
    const { sessionRoot, filePath } = await hostFile(state);
    const viewer = roleClient("view", "file-viewer");
    const writer = roleClient("write", "file-writer");
    const entry = {
      spawnedCwd: sessionRoot,
      permissionMode: "full" as const,
      visibility: "shared" as const,
    };
    const actor = (id: string) => ({ type: "human" as const, source: "profile" as const, id });
    await seedSession(target, {
      ...entry,
      createdActor: actor(viewer.authenticatedUserProfile!.profileId),
    });
    const foreign = { ...target, sessionKey: "agent:main:foreign-file", sessionId: "foreign" };
    await seedSession(foreign, { ...entry, createdActor: actor("another-person") });
    using rpc = await fileGateway(cfg);
    for (const [client, scope, selected, allowed] of [
      [viewer, "operator.sessions.write", target, true],
      [viewer, "operator.sessions.write", foreign, false],
      [viewer, "operator.write", foreign, false],
      [writer, "operator.read", foreign, false],
      [writer, "operator.write", foreign, true],
    ] as const) {
      client.connect.scopes = [scope];
      const [ok, payload, error] = (await rpc.read(client, selected.sessionKey, filePath)).mock
        .calls[0]!;
      expect(ok).toBe(allowed);
      if (allowed) {
        expectFile(payload);
      } else {
        expect(error).toMatchObject({
          details: { type: "session_file_not_found", reason: "outside_session_boundary" },
        });
      }
    }
    expect(rpc.context.addChatRun).not.toHaveBeenCalled();
  });
});

it("keeps solo and admin incognito reads inside prepared authorization without synchronous SQL", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = {};
    setRuntimeConfigSnapshot(cfg);
    const { sessionRoot, filePath } = await hostFile(state);
    const privateTarget = {
      ...target,
      sessionKey: "agent:main:dashboard:incognito-file-turn",
      sessionId: "private-file-turn",
    };
    const mainTarget = { ...target, sessionKey: "agent:main:main", sessionId: "main-file-turn" };
    for (const selected of [target, privateTarget, mainTarget]) {
      await seedSession(selected, {
        spawnedCwd: sessionRoot,
        permissionMode: selected === privateTarget ? "full" : undefined,
        ...(selected === privateTarget ? { incognito: true } : {}),
      });
    }
    using rpc = await fileGateway(cfg);
    const { projection } = rpc;
    const prepare = projection.withPreparedExactRows.bind(projection);
    vi.spyOn(projection, "withPreparedExactRows").mockImplementation((queries, consume) =>
      prepare(queries, (read) => {
        const sql = observeSqliteReadSql(StatementSync.prototype);
        try {
          const result = consume(read);
          expect(sql.queries).toEqual([]);
          return result;
        } finally {
          sql.restore();
        }
      }),
    );
    for (const requestedKey of [target.sessionKey, privateTarget.sessionKey, "main"]) {
      for (const scopes of [["operator.write"], ["operator.admin"]]) {
        const [ok, payload] = (
          await rpc.read(sharingPolicyClient({ scopes }), requestedKey, filePath)
        ).mock.calls[0]!;
        expect(ok).toBe(true);
        expectFile(payload, { path: await fs.realpath(filePath) });
      }
    }
    expect(projection.selectEntries().map((row) => row.key)).not.toContain(
      privateTarget.sessionKey,
    );
  });
});

it("rechecks scopes and the original session incarnation after file I/O", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = {};
    setRuntimeConfigSnapshot(cfg);
    using rpc = await fileGateway(cfg, false);
    for (const changed of ["scope", "session"] as const) {
      await seedSession(target);
      const client = sharingPolicyClient({ scopes: ["operator.write"] });
      const publish = vi.fn();
      const respond = await rpc.read(client, target.sessionKey, "/outside.html", {
        "sessions.files.get": async ({ withSessionTurnAuthority, respond: publishResponse }) => {
          if (!withSessionTurnAuthority) {
            throw new Error("Missing router turn authority");
          }
          const entry = await withSessionTurnAuthority(target, (current) => current);
          expect(entry.sessionId).toBe(target.sessionId);
          if (changed === "scope") {
            client.connect.scopes = ["operator.read"];
          } else {
            await upsertSessionEntryCore(target, { sessionId: "replacement", updatedAt: 2 });
          }
          await withSessionTurnAuthority(target, () => {
            publish();
            publishResponse(true, { content: "private file" });
          });
        },
      });
      expect(publish).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining({ code: "FORBIDDEN" }),
      );
    }
  });
});
