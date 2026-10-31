import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import * as workspaceOwner from "../../agents/workspace.js";
import * as configBackup from "../../config/backup-rotation.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  registerRuntimeConfigWriteListener,
} from "../../config/runtime-snapshot.js";
import { getRuntimeConfigWriteApplication } from "../../config/runtime-write-application.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as fsSafe from "../../infra/fs-safe.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { callAgentHandler } from "./agents-mutate.test-support.js";
import { agentsHandlers } from "./agents.js";
import type { GatewayClient } from "./client-types.js";

const inlineAvatar = "data:image/png;base64,AQID";
const originalIdentity = "# Identity\n\n- Name: Existing\n\nKeep these notes.\n";
const updated = { ok: true, agentId: "existing" };
const uploadsDisabled = expect.objectContaining({
  code: "FORBIDDEN",
  details: { code: "UPLOADS_DISABLED" },
});
let state: OpenClawTestState;
let config: OpenClawConfig;
let workspace: string;
let identityPath: string;
let serial = 0;
let releaseConfigWriteListener: () => void;
const context = createDirectChatContext({
  getRuntimeConfig: () => config,
  getCommittedRuntimeConfig: () => config,
});
const client: GatewayClient = {
  connId: "avatar-policy-client",
  connect: {
    minProtocol: 1,
    maxProtocol: 1,
    client: { id: "test", version: "1", platform: "test", mode: "test" },
  },
};
const readIdentity = () => fs.readFile(identityPath, "utf8");
const readConfig = () => fs.readFile(state.configPath, "utf8");
const workspaceState = (bootstrapPending = false) => ({
  dir: workspace,
  identityPathCreated: false,
  bootstrapPending,
});
function disableUploads() {
  config = { ...config, gateway: { uploads: { enabled: false } } };
}
function configureIdentity(avatar?: string) {
  const identity = { name: "Existing", ...(avatar ? { avatar } : {}) };
  config = {
    gateway: { uploads: { enabled: true } },
    agents: { entries: { existing: { workspace, identity } } },
  };
}
function expectSuccess(respond: ReturnType<typeof vi.fn>, payload = expect.anything()) {
  expect(respond).toHaveBeenCalledExactlyOnceWith(true, payload, undefined);
}
async function expectPersistedAvatar() {
  expect(await readIdentity()).toContain(inlineAvatar);
  expect(await readConfig()).toContain(inlineAvatar);
}
function call(
  method: "agents.create" | "agents.update",
  fields: Record<string, unknown> = { avatar: inlineAvatar },
  requester = client,
) {
  const target =
    method === "agents.create" ? { name: "New Avatar Agent", workspace } : { agentId: "existing" };
  const params = { ...target, ...fields };
  return callAgentHandler(agentsHandlers[method]!, method, params, { context, client: requester });
}
beforeAll(async () => {
  state = await createOpenClawTestState({ layout: "state-only", label: "agent-avatar-policy" });
  // Standalone IO publishes its runtime snapshot before this notification. Upload
  // authority stays separately injected so a concurrent revocation remains current.
  releaseConfigWriteListener = registerRuntimeConfigWriteListener((event) => {
    if (event.configPath === state.configPath) {
      getRuntimeConfigWriteApplication(event)
        ?.claim()
        ?.settle(getRuntimeConfigSnapshot() === event.runtimeConfig ? "applied" : "failed");
    }
  });
});
afterAll(async () => {
  releaseConfigWriteListener();
  await state.cleanup();
});
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  clearRuntimeConfigSnapshot();
  workspace = state.path("workspace-" + ++serial);
  identityPath = path.join(workspace, "IDENTITY.md");
  await fs.mkdir(workspace);
  await fs.writeFile(identityPath, originalIdentity);
  configureIdentity();
  await state.writeConfig(config);
  // Workspace bootstrap has its own authority tests. Keep this boundary fixture on
  // the existing, already-hatched workspace and the real identity/config writers.
  vi.spyOn(workspaceOwner, "ensureAgentWorkspace").mockImplementation(async () => workspaceState());
});

it.each([
  { method: "agents.create", stage: "identity-write" },
  { method: "agents.update", stage: "identity-write" },
  { method: "agents.create", stage: "config" },
  { method: "agents.update", stage: "config" },
  { method: "agents.create", stage: "unpublished-config" },
  { method: "agents.update", stage: "remote-read" },
  { method: "agents.update", stage: "remote-write" },
] as const)("$method: upload revocation at $stage", async ({ method, stage }) => {
  const entered = createDeferred();
  const resume = createDeferred();
  const pause = async () => {
    entered.resolve();
    await resume.promise;
  };
  const pauseBefore =
    <A extends unknown[], R>(action: (...args: A) => Promise<R>) =>
    async (...args: A) => {
      await pause();
      return await action(...args);
    };
  let release: (() => void) | undefined;
  const writeFile = vi.fn(async (params: { data: string | Uint8Array }) => {
    await fs.writeFile(identityPath, params.data);
    await pause();
  });
  if (stage === "identity-write") {
    const realRoot = fsSafe.root;
    vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
      const handle = await realRoot(...args);
      if (args[0] === workspace) {
        const write = handle.write.bind(handle);
        vi.spyOn(handle, "write").mockImplementation(pauseBefore(write));
      }
      return handle;
    });
  } else if (stage === "config" || stage === "unpublished-config") {
    if (stage === "unpublished-config") {
      vi.mocked(workspaceOwner.ensureAgentWorkspace).mockResolvedValue(workspaceState(true));
    }
    const prepare = configBackup.prepareConfigFileWrite;
    vi.spyOn(configBackup, "prepareConfigFileWrite").mockImplementation(pauseBefore(prepare));
  } else {
    release = registerAgentWorkspaceAccess(workspace, {
      bridge: {
        readFile:
          stage === "remote-read"
            ? pauseBefore(async () => Buffer.from(originalIdentity))
            : () => fs.readFile(identityPath),
        writeFile,
        stat: vi.fn(),
      },
    });
  }
  const originalConfig = await readConfig();
  const pending = call(method);
  try {
    await awaitGateBeforeSettlement(entered.promise, pending, `handler did not reach ${stage}`);
    const accepted = stage === "config" || stage === "remote-write";
    const admittedIdentity = await readIdentity();
    if (accepted) {
      expect(admittedIdentity).toContain(inlineAvatar);
    } else if (stage === "unpublished-config") {
      expect(admittedIdentity).toBe(originalIdentity);
    }
    disableUploads();
    resume.resolve();
    const respond = await pending;
    if (accepted) {
      expectSuccess(respond, method === "agents.update" ? updated : expect.anything());
      expect(await readConfig()).toContain(inlineAvatar);
      expect(await readIdentity()).toBe(admittedIdentity);
    } else {
      expect.soft(respond).toHaveBeenCalledExactlyOnceWith(false, undefined, uploadsDisabled);
      expect.soft(await readIdentity()).toBe(originalIdentity);
      expect.soft(await readConfig()).toBe(originalConfig);
      if (stage === "remote-read") {
        expect.soft(writeFile).not.toHaveBeenCalled();
      }
    }
  } finally {
    resume.resolve();
    await pending;
    release?.();
  }
});

it.each(["agents.create", "agents.update"] as const)(
  "%s: URL edits and trusted internal avatars",
  async (method) => {
    disableUploads();
    const fields = { avatar: "https://example.test/avatar.png", name: "Text Name" };
    expectSuccess(await call(method, fields));
    expect(await readIdentity()).toContain(fields.avatar);
    expect(await readIdentity()).toContain("Keep these notes.");
    const internal = { ...client, internal: { syntheticClient: true as const } };
    expectSuccess(await call(method, { avatar: inlineAvatar }, internal));
    await expectPersistedAvatar();
  },
);

it("allows text-only edits to an existing inline avatar while uploads are disabled", async () => {
  configureIdentity(inlineAvatar);
  disableUploads();
  await state.writeConfig(config);
  expectSuccess(await call("agents.update", { name: "Text Only" }), updated);
  expect(await readIdentity()).toContain("- Name: Text Only");
  await expectPersistedAvatar();
});
