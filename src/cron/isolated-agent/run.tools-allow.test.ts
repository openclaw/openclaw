import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../agents/test-helpers/fast-coding-tools.js";
import {
  clearActiveRuntimeWebToolsMetadata,
  setActiveRuntimeWebToolsMetadata,
} from "../../secrets/runtime-web-tools-state.js";
import type { CronStoredJob } from "../types.js";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  hasUsableWebSearchProviderMock,
  loadModelCatalogMock,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  resolveConfiguredModelRefMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const options = { timeout: 300_000 };
const command = "Command to run:\n- command: python3 scripts/check_mail.py";
const policy: NonNullable<CronStoredJob["scheduledToolPolicy"]> = {
  version: 1,
  mode: "account",
  ownerSessionKey: "agent:main:whatsapp:group:team",
  ownerAccountId: "default",
};

function makeParams(
  toolsAllow: string[],
  payload: Partial<Extract<CronStoredJob["payload"], { kind: "agentTurn" }>> = {},
  job: Partial<CronStoredJob> = {},
) {
  return makeIsolatedAgentParamsFixture({
    message: "check allowed tools",
    sessionKey: "cron:tools-allow",
    job: {
      id: "tools-allow",
      name: "Tools Allow",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      delivery: { mode: "none" },
      owner: { agentId: "main", sessionKey: policy.ownerSessionKey, accountId: "default" },
      scheduledToolPolicy: policy,
      toolsAllowProvenance: {
        version: 1,
        source: "final-executable-surface",
        callerOrigin: { kind: "external", channel: "whatsapp" },
      },
      payload: { kind: "agentTurn", message: "check allowed tools", toolsAllow, ...payload },
      ...job,
    },
  });
}

describe("runCronIsolatedAgentTurn toolsAllow", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });
  beforeEach(() => {
    clearActiveRuntimeWebToolsMetadata();
    mockRunCronFallbackPassthrough();
  });
  afterEach(clearActiveRuntimeWebToolsMetadata);

  it("keeps accountless legacy jobs on the sender-policy path", options, async () => {
    await runCronIsolatedAgentTurn(
      makeParams(["cron"], {}, { owner: { agentId: "main", sessionKey: policy.ownerSessionKey } }),
    );
    const call = runEmbeddedAgentMock.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.toolsAllow).toEqual(["cron"]);
    expect(call.scheduledToolPolicy).toBeUndefined();
  });

  it("preserves local provenance for scheduled message tools", options, async () => {
    await runCronIsolatedAgentTurn(
      makeParams(
        ["message"],
        { toolsAllowIsDefault: true },
        {
          toolsAllowProvenance: {
            version: 1,
            source: "final-executable-surface",
            callerOrigin: { kind: "local" },
          },
        },
      ),
    );
    expect(runEmbeddedAgentMock.mock.calls[0]?.[0]?.scheduledToolPolicy).toEqual({
      ...policy,
      ownerOrigin: { kind: "local" },
    });
  });

  it("runs a command prompt from an automatic snapshot without shell tools", options, async () => {
    const result = await runCronIsolatedAgentTurn(
      makeParams(["message", "read"], { toolsAllowIsDefault: true, message: command }),
    );
    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock.mock.calls[0]?.[0]?.toolsAllow).toEqual(["*"]);
  });

  it.each([
    { label: "runs with its owner's tools", job: {}, expected: ["*"] },
    {
      label: "keeps its list without a valid owner policy",
      job: { owner: { agentId: "main", sessionKey: policy.ownerSessionKey } },
      expected: ["message", "read"],
    },
    {
      label: "keeps its list behind a condition trigger",
      job: { trigger: { script: "return { fire: true }" } },
      expected: ["message", "read"],
    },
  ])("an automatic creator snapshot $label", options, async ({ job, expected }) => {
    // Older builds saved this snapshot without the creator's native shell.
    await runCronIsolatedAgentTurn(
      makeParams(["message", "read"], { toolsAllowIsDefault: true }, job),
    );
    expect(runEmbeddedAgentMock.mock.calls[0]?.[0]?.toolsAllow).toEqual(expected);
  });

  it.each([
    ["unavailable shell tools", ["terminal", "node_exec", "node_process"]],
    ["a blank entry", [" "]],
  ])(
    "rejects command prompts with %s before model execution",
    options,
    async (_label, toolsAllow) => {
      const result = await runCronIsolatedAgentTurn(
        makeParams(toolsAllow, { message: `${command}\n- workdir: /srv/openclaw` }),
      );
      expect(result).toMatchObject({
        status: "error",
        admissionDisposition: "rejected",
        error: expect.stringContaining(
          "openclaw automations edit tools-allow --tools exec,process",
        ),
        diagnostics: {
          summary: expect.stringContaining("No command was executed"),
          entries: [expect.objectContaining({ source: "cron-preflight", severity: "error" })],
        },
      });
      expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(resolveConfiguredModelRefMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { toolsAllow: ["exec", "read"], message: `${command}\n- workdir: /srv/openclaw` },
    { toolsAllow: ["process"], message: command },
  ])(
    "runs command prompts with the account-bound cap $toolsAllow",
    options,
    async ({ toolsAllow, message }) => {
      const result = await runCronIsolatedAgentTurn(makeParams(toolsAllow, { message }));
      expect(result.status).toBe("ok");
      expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      const call = runEmbeddedAgentMock.mock.calls[0]?.[0];
      expect(call.jobId).toBe("tools-allow");
      expect(call.toolsAllow).toEqual(toolsAllow);
      expect(call.scheduledToolPolicy).toEqual({
        ...policy,
        ownerOrigin: { kind: "external", channel: "whatsapp" },
      });
    },
  );

  it("uses the prepared plugin-scoped web search provider", options, async () => {
    setActiveRuntimeWebToolsMetadata({
      search: {
        providerSource: "auto-detect",
        selectedProvider: "brave",
        selectedProviderKeySource: "config",
        diagnostics: [],
      },
      fetch: { providerSource: "none", diagnostics: [] },
      diagnostics: [],
    });
    const result = await runCronIsolatedAgentTurn({
      ...makeParams(["web_search"]),
      cfg: {
        plugins: {
          entries: {
            brave: { enabled: true, config: { webSearch: { apiKey: "token-oversized" } } },
          },
        },
      },
    });
    expect(result.status).toBe("ok");
    expect(result.diagnostics).toBeUndefined();
    expect(hasUsableWebSearchProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: "/tmp/agent-dir",
        preferRuntimeProviders: true,
        runtimeWebSearch: expect.objectContaining({ selectedProvider: "brave" }),
      }),
    );
  });

  it("does not warn when native web_search supplies the tool", options, async () => {
    resolveConfiguredModelRefMock.mockReturnValue({ provider: "gateway", model: "gpt-5.5" });
    loadModelCatalogMock.mockResolvedValue([
      { id: "gpt-5.5", name: "GPT-5.5", provider: "gateway", api: "openai-chatgpt-responses" },
    ]);
    const result = await runCronIsolatedAgentTurn({
      ...makeParams(["web_search"]),
      cfg: {
        tools: {
          web: { search: { enabled: true, openaiCodex: { enabled: true, mode: "cached" } } },
        },
      },
    });
    expect(result.status).toBe("ok");
    expect(result.diagnostics).toBeUndefined();
  });

  it("does not warn about web_search recorded in an automatic snapshot", options, async () => {
    const result = await runCronIsolatedAgentTurn(
      makeParams(
        ["read", "web_search"],
        { toolsAllowIsDefault: true },
        { trigger: { script: "return { fire: true }" } },
      ),
    );
    expect(result.status).toBe("ok");
    expect(result.diagnostics).toBeUndefined();
  });

  it("keeps missing web_search provider diagnostics when the run aborts", options, async () => {
    runWithModelFallbackMock.mockResolvedValueOnce({
      result: { result: { payloads: [], meta: { aborted: true, agentMeta: {} } } },
      provider: "openai",
      model: "gpt-5.4",
      attempts: [],
    });
    const result = await runCronIsolatedAgentTurn(makeParams(["web_search"]));
    expect(result.status).toBe("error");
    expect(result.diagnostics?.entries.map((entry) => entry.message)).toEqual([
      "web_search tool requested in toolsAllow but no web search provider is selected. Configure one with: openclaw configure --section web, or set tools.web.search.provider.",
      "cron isolated agent run aborted",
    ]);
    expect(result.diagnostics?.entries[0]).toMatchObject({
      source: "cron-preflight",
      severity: "warn",
      toolName: "web_search",
      ts: expect.any(Number),
    });
  });
});
