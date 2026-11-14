import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { commandResult } from "../../agents/github-identity.test-support.js";
import {
  clearNativeGitHubTokenCache,
  refreshNativeGitHubConfiguration,
} from "../../agents/github-read-identity.js";
import * as processExec from "../../process/exec.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "../session-utils-store-worker.js";
import { toolsEffectiveInventoryMocks as inventoryMocks } from "./tools-effective.test-support.js";

const { toolsEffectiveHandlers, testing } = await import("./tools-effective.js");

vi.mock("../session-utils-store-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils-store-worker.js")>()),
  loadGatewaySessionEntryReadOnlyInWorker: vi.fn(),
}));

beforeEach(() => {
  testing.resetToolsEffectiveCacheForTest();
  clearNativeGitHubTokenCache();
  vi.clearAllMocks();
});

it.each(["openclaw", "codex"])(
  "invalidates inventory only for its owning runtime: %s",
  async (runtime) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    onTestFinished(() => clock.mockRestore());
    onTestFinished(clearNativeGitHubTokenCache);
    const sessionKey = "agent:main:subagent:policy-refresh";
    const loaded: Awaited<ReturnType<typeof loadGatewaySessionEntryReadOnlyInWorker>> = {
      cfg: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-4.1" },
            models: { "openai/gpt-4.1": { agentRuntime: { id: runtime } } },
          },
          entries: { main: {} },
        },
      },
      agentId: "main",
      storePath: "/tmp/tools-effective-policy-refresh/sessions.sqlite",
      store: {},
      canonicalKey: sessionKey,
      storeKeys: [sessionKey],
      legacyKey: undefined,
      entry: {
        sessionId: "unchanged-session",
        updatedAt: 1,
        spawnDepth: 1,
        spawnedBy: "agent:main:main",
        inheritedToolPolicyVersion: 1,
      },
    };
    vi.mocked(loadGatewaySessionEntryReadOnlyInWorker)
      .mockResolvedValue({
        ...loaded,
        entry: { ...expectDefined(loaded.entry, "session fixture"), inheritedToolDeny: ["exec"] },
      })
      .mockResolvedValueOnce(loaded);
    const handler = expectDefined(
      toolsEffectiveHandlers["tools.effective"],
      "tools.effective handler",
    );
    const invoke = async () => {
      const respond = vi.fn();
      await handler({
        params: { sessionKey },
        respond: respond as never,
        context: { getRuntimeConfig: () => loaded.cfg } as never,
        client: null,
        req: { type: "req", id: "req-policy-refresh", method: "tools.effective" },
        isWebchatConnect: () => false,
      });
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      return respond.mock.calls[0]?.[1];
    };

    const first = await invoke();
    expect(inventoryMocks.resolveEffectiveToolInventory.mock.calls[0]?.[0].agentRuntime).toBe(
      runtime,
    );
    inventoryMocks.resolveEffectiveToolInventory.mockResolvedValueOnce({
      agentId: "main",
      profile: "coding",
      groups: [],
    });
    const second = await invoke();

    expect(first).toMatchObject({ groups: [{ tools: [{ id: "exec" }] }] });
    expect(second).toMatchObject({ groups: [] });
    expect(inventoryMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(2);
    expect(
      inventoryMocks.resolveEffectiveToolInventory.mock.calls[1]?.[0].conversationCapabilityProfile,
    ).toMatchObject({ policy: { inheritedToolPolicy: { deny: ["exec"] } } });
    await invoke();
    expect(inventoryMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(2);
    vi.stubEnv("GH_TOKEN", undefined);
    vi.stubEnv("GITHUB_TOKEN", undefined);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const native = vi
      .spyOn(processExec, "runCommandBuffered")
      .mockImplementation(async (argv) =>
        commandResult(argv[2] === "status" ? '{"hosts":{}}' : "", argv[2] === "status" ? 0 : 1),
      );
    onTestFinished(() => native.mockRestore());
    await refreshNativeGitHubConfiguration();
    await invoke();
    await invoke();
    expect(inventoryMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(
      runtime === "openclaw" ? 3 : 2,
    );
    expect(native).toHaveBeenCalledTimes(2);
  },
);
