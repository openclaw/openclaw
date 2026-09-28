import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import * as workspaceOwner from "../../agents/workspace.js";
import * as configBackup from "../../config/backup-rotation.js";
import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as fsSafe from "../../infra/fs-safe.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { agentsHandlers } from "./agents.js";
import type { GatewayClient } from "./client-types.js";

const inlineAvatar = "data:image/png;base64,AQID";
const originalIdentity = "# Identity\n\n- Name: Existing\n\nKeep these notes.\n";
let state: OpenClawTestState;
let config: OpenClawConfig;
let workspace: string;
let identityPath: string;
let serial = 0;
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
function disableUploads() {
  config = { ...config, gateway: { uploads: { enabled: false } } };
}
async function call(
  method: "agents.create" | "agents.update",
  fields: Record<string, unknown> = { avatar: inlineAvatar },
  requester = client,
) {
  const respond = vi.fn();
  const params = {
    ...(method === "agents.create"
      ? { name: "New Avatar Agent", workspace }
      : { agentId: "existing" }),
    ...fields,
  };
  await agentsHandlers[method]!({
    req: { type: "req", id: "avatar-policy", method, params },
    params,
    context,
    respond,
    client: requester,
    isWebchatConnect: () => false,
  });
  return respond;
}
function expectDisabled(respond: ReturnType<typeof vi.fn>) {
  expect
    .soft(respond)
    .toHaveBeenCalledExactlyOnceWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN", details: { code: "UPLOADS_DISABLED" } }),
    );
}

beforeAll(async () => {
  state = await createOpenClawTestState({ layout: "state-only", label: "agent-avatar-policy" });
});
afterAll(async () => {
  await state.cleanup();
});
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(async () => {
  clearRuntimeConfigSnapshot();
  workspace = state.path("workspace-" + ++serial);
  identityPath = path.join(workspace, "IDENTITY.md");
  await fs.mkdir(workspace);
  await fs.writeFile(identityPath, originalIdentity);
  config = {
    gateway: { uploads: { enabled: true } },
    agents: {
      entries: { existing: { workspace, identity: { name: "Existing" } } },
    },
  };
  await state.writeConfig(config);
  // Workspace bootstrap has its own authority tests. Keep this boundary fixture on
  // the existing, already-hatched workspace and the real identity/config writers.
  vi.spyOn(workspaceOwner, "ensureAgentWorkspace").mockImplementation(async () => ({
    dir: workspace,
    identityPathCreated: false,
    bootstrapPending: false,
  }));
});

it.each(["agents.create", "agents.update"] as const)(
  "%s refuses inline avatar bytes after asynchronous identity write preparation",
  async (method) => {
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const realRoot = fsSafe.root;
    vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
      const handle = await realRoot(...args);
      if (args[0] !== workspace) {
        return handle;
      }
      const write = handle.write.bind(handle);
      vi.spyOn(handle, "write").mockImplementation(async (...writeArgs) => {
        entered.resolve();
        await resume.promise;
        return await write(...writeArgs);
      });
      return handle;
    });
    const originalConfig = await fs.readFile(state.configPath, "utf8");
    const pending = call(method);
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("handler did not reach identity write");
        }),
      ]);
      disableUploads();
      resume.resolve();
      expectDisabled(await pending);
      expect.soft(await fs.readFile(identityPath, "utf8")).toBe(originalIdentity);
      expect.soft(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
    } finally {
      resume.resolve();
      await pending;
    }
  },
);

it.each(["agents.create", "agents.update"] as const)(
  "%s settles an accepted avatar at native config preparation",
  async (method) => {
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const prepare = configBackup.prepareConfigFileWrite;
    vi.spyOn(configBackup, "prepareConfigFileWrite").mockImplementation(async (params) => {
      entered.resolve();
      await resume.promise;
      return await prepare(params);
    });
    const pending = call(method);
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("handler did not reach config preparation");
        }),
      ]);
      // These exact bytes already passed publication admission. Finish their config
      // projection instead of reporting a denial with a hidden durable identity write.
      const admittedIdentity = await fs.readFile(identityPath, "utf8");
      expect(admittedIdentity).toContain(inlineAvatar);
      disableUploads();
      resume.resolve();
      expect(await pending).toHaveBeenCalledExactlyOnceWith(true, expect.anything(), undefined);
      expect(await fs.readFile(state.configPath, "utf8")).toContain(inlineAvatar);
      expect(await fs.readFile(identityPath, "utf8")).toBe(admittedIdentity);
    } finally {
      resume.resolve();
      await pending;
    }
  },
);

it("agents.update refuses remote avatar dispatch after its identity read yields", async () => {
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  const writeFile = vi.fn(async () => {});
  const release = registerAgentWorkspaceAccess(workspace, {
    bridge: {
      readFile: async () => {
        entered.resolve();
        await resume.promise;
        return Buffer.from(originalIdentity);
      },
      writeFile,
      stat: vi.fn(),
    },
  });
  const originalConfig = await fs.readFile(state.configPath, "utf8");
  const pending = call("agents.update");
  try {
    await Promise.race([
      entered.promise,
      pending.then(() => {
        throw new Error("handler did not reach remote read");
      }),
    ]);
    disableUploads();
    resume.resolve();
    expectDisabled(await pending);
    expect.soft(writeFile).not.toHaveBeenCalled();
    expect.soft(await fs.readFile(identityPath, "utf8")).toBe(originalIdentity);
    expect.soft(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
  } finally {
    resume.resolve();
    await pending;
    release();
  }
});

it.each(["agents.create", "agents.update"] as const)(
  "%s preserves non-upload identity edits and trusted internal avatar creation",
  async (method) => {
    disableUploads();
    const fields = { avatar: "https://example.test/avatar.png", name: "Text Name" };
    expect(await call(method, fields)).toHaveBeenCalledWith(true, expect.anything(), undefined);
    expect(await fs.readFile(identityPath, "utf8")).toContain(fields.avatar);
    expect(await fs.readFile(identityPath, "utf8")).toContain("Keep these notes.");
    const internal = { ...client, internal: { syntheticClient: true as const } };
    expect(await call(method, { avatar: inlineAvatar }, internal)).toHaveBeenCalledWith(
      true,
      expect.anything(),
      undefined,
    );
    expect(await fs.readFile(identityPath, "utf8")).toContain(inlineAvatar);
    expect(await fs.readFile(state.configPath, "utf8")).toContain(inlineAvatar);
  },
);

it("allows text-only edits to an existing inline avatar while uploads are disabled", async () => {
  config = {
    ...config,
    agents: {
      entries: { existing: { workspace, identity: { name: "Existing", avatar: inlineAvatar } } },
    },
  };
  disableUploads();
  await state.writeConfig(config);
  expect(await call("agents.update", { name: "Text Only" })).toHaveBeenCalledWith(
    true,
    { ok: true, agentId: "existing" },
    undefined,
  );
  expect(await fs.readFile(identityPath, "utf8")).toContain("- Name: Text Only");
  expect(await fs.readFile(identityPath, "utf8")).toContain(inlineAvatar);
  expect(await fs.readFile(state.configPath, "utf8")).toContain(inlineAvatar);
});

it("agents.create still rejects at config preparation when no identity was published", async () => {
  vi.mocked(workspaceOwner.ensureAgentWorkspace).mockResolvedValue({
    dir: workspace,
    identityPathCreated: false,
    bootstrapPending: true,
  });
  const prepare = configBackup.prepareConfigFileWrite;
  vi.spyOn(configBackup, "prepareConfigFileWrite").mockImplementation(async (params) => {
    expect(await fs.readFile(identityPath, "utf8")).toBe(originalIdentity);
    disableUploads();
    return await prepare(params);
  });
  const originalConfig = await fs.readFile(state.configPath, "utf8");
  expectDisabled(await call("agents.create"));
  expect(await fs.readFile(identityPath, "utf8")).toBe(originalIdentity);
  expect(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
});

it("agents.update settles an accepted remote avatar when its write acknowledgment yields", async () => {
  const writeFile = vi.fn(async (params: { data: string | Uint8Array }) => {
    await fs.writeFile(identityPath, params.data);
    disableUploads();
  });
  const release = registerAgentWorkspaceAccess(workspace, {
    bridge: {
      readFile: async () => await fs.readFile(identityPath),
      writeFile,
      stat: vi.fn(),
    },
  });
  try {
    expect(await call("agents.update")).toHaveBeenCalledExactlyOnceWith(
      true,
      { ok: true, agentId: "existing" },
      undefined,
    );
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(identityPath, "utf8")).toContain(inlineAvatar);
    expect(await fs.readFile(state.configPath, "utf8")).toContain(inlineAvatar);
  } finally {
    release();
  }
});
