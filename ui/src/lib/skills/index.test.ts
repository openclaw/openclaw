// @vitest-environment node
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SkillStatusReport } from "../../api/types.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createRuntimeConfigCapability } from "../config/runtime-config-capability.ts";
import { searchClawHub } from "./clawhub-search.ts";
import { createDeferredRequestQueue, type TestRequest } from "./index.test-support.ts";
import {
  clawhubVerdictKey,
  installFromClawHub,
  installSkill,
  loadSkills,
  loadSkillCard,
  loadClawHubDetail,
  refreshSkills,
  reconcileSkillsAgentId,
  saveSkillApiKey,
  setSkillsAgentId,
  updateSkillEdit,
  updateSkillEnabled,
} from "./index.ts";

type SkillsState = Parameters<typeof loadSkills>[0];

function createState(): { state: SkillsState; request: ReturnType<typeof vi.fn<TestRequest>> } {
  const request = vi.fn<TestRequest>();
  const state: SkillsState = {
    client: { request } as unknown as SkillsState["client"],
    connected: true,
    runtimeConfig: {
      runExternalMutation: async (task) => {
        try {
          return {
            ok: true,
            value: await task(expectDefined(state.client, "connected skill mutation client")),
            refresh: { ok: true },
          };
        } catch (error) {
          return {
            ok: false,
            reason: "error",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    },
    skillsAgentId: "main",
    skillsAgentRevision: 0,
    skillsLoading: false,
    skillsReport: null,
    skillsError: null,
    skillOperation: null,
    skillEdits: {},
    skillMessages: {},
    clawhubSearchResults: [],
    clawhubSearchLoading: false,
    clawhubSearchError: "old error",
    clawhubIconUrls: {},
    clawhubDetail: null,
    clawhubDetailRef: null,
    clawhubDetailLoading: false,
    clawhubDetailError: null,
    clawhubInstallMessage: null,
    clawhubVerdicts: {},
    clawhubVerdictsLoading: false,
    clawhubVerdictsError: null,
    skillCardContents: {},
    skillCardContentKeys: {},
    skillCardLoadingKey: null,
    skillCardErrors: {},
  };
  return { state, request };
}

function statusReport(workspaceDir = "/tmp/workspace", skills: unknown[] = []) {
  return { workspaceDir, managedSkillsDir: "/tmp/skills", skills };
}

async function attachRuntimeConfig(state: SkillsState) {
  const runtimeConfig = createRuntimeConfigCapability({
    snapshot: {
      client: expectDefined(state.client, "connected skill mutation client"),
      phase: "connected",
      sessionKey: "main",
      hello: gatewayHelloForMethods(["config.set"]),
    },
    subscribe: () => () => undefined,
  });
  state.runtimeConfig = runtimeConfig;
  await runtimeConfig.ensureLoaded();
  return runtimeConfig;
}

function linkedSkill(slug = "agentreceipt", ownerHandle?: string, installedAt = 123) {
  return {
    name: slug,
    skillKey: ownerHandle ? `${ownerHandle}-${slug}` : slug,
    source: "workspace",
    clawhub: {
      status: "linked",
      valid: true,
      registry: "https://clawhub.ai",
      slug,
      ownerHandle,
      installedVersion: "1.2.3",
      installedAt,
    },
  };
}

function verdict(ownerHandle?: string, passed = true) {
  const slug = ownerHandle ? "weather" : "agentreceipt";
  return {
    registry: "https://clawhub.ai",
    ok: passed,
    decision: passed ? "pass" : "fail",
    reasons: passed ? [] : ["security.suspicious"],
    requestedSlug: slug,
    requestedOwnerHandle: ownerHandle,
    requestedVersion: "1.2.3",
    publisherHandle: ownerHandle,
    slug,
    version: "1.2.3",
    securityStatus: passed ? "clean" : "suspicious",
    securityPassed: passed,
  };
}

function createSkillCardReport(installedVersion?: string, installedAt = 123): SkillStatusReport {
  return {
    workspaceDir: "/tmp/workspace",
    managedSkillsDir: "/tmp/skills",
    skills: [
      {
        name: "AgentReceipt",
        description: "Trust card fixture",
        skillKey: "agentreceipt",
        source: "workspace",
        bundled: false,
        filePath: "/tmp/workspace/skills/agentreceipt/SKILL.md",
        baseDir: "/tmp/workspace/skills/agentreceipt",
        always: false,
        disabled: false,
        blockedByAllowlist: false,
        blockedByAgentFilter: false,
        eligible: true,
        platformIncompatible: false,
        modelVisible: true,
        userInvocable: true,
        commandVisible: true,
        requirements: { anyBins: [], bins: [], env: [], config: [], os: [] },
        missing: { anyBins: [], bins: [], env: [], config: [], os: [] },
        configChecks: [],
        install: [],
        ...(installedVersion
          ? {
              clawhub: {
                status: "linked",
                valid: true,
                registry: "https://clawhub.ai",
                slug: "agentreceipt",
                installedVersion,
                installedAt,
                originPath: "/tmp/workspace/skills/agentreceipt/.clawhub/origin.json",
                lockPath: "/tmp/workspace/.clawhub/lock.json",
              },
            }
          : {}),
        skillCard: {
          present: true,
          path: "/tmp/workspace/skills/agentreceipt/skill-card.md",
          sizeBytes: 34,
        },
      },
    ],
  };
}

describe("loadSkills", () => {
  it("does not issue an ownerless status request", async () => {
    const { state, request } = createState();
    state.skillsAgentId = null;
    await loadSkills(state);
    expect(request).not.toHaveBeenCalled();
  });

  it("requests one bulk ClawHub verdict batch for linked installed skills", async () => {
    const { state, request } = createState();
    state.skillsAgentId = "research";
    request.mockImplementation(async (method: string) => {
      if (method === "skills.status") {
        return statusReport("/tmp/research", [
          linkedSkill(),
          { name: "Local", skillKey: "local", source: "workspace" },
        ]);
      }
      if (method === "skills.securityVerdicts") {
        return {
          schema: "openclaw.skills.security-verdicts.v1",
          items: [verdict()],
        };
      }
      return {};
    });
    await loadSkills(state);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, "skills.status", { agentId: "research" });
    expect(request).toHaveBeenNthCalledWith(2, "skills.securityVerdicts", { agentId: "research" });
    expect(state.clawhubVerdicts).toEqual({
      [clawhubVerdictKey({
        registry: "https://clawhub.ai",
        slug: "agentreceipt",
        version: "1.2.3",
      })]: expect.objectContaining({
        ok: true,
        decision: "pass",
        securityStatus: "clean",
        securityPassed: true,
      }),
    });
    expect(state.skillsReport?.workspaceDir).toBe("/tmp/research");
    expect(state.clawhubVerdictsLoading).toBe(false);
    expect(state.clawhubVerdictsError).toBeNull();
  });

  it("keeps verdicts for the same slug distinct by installed owner", async () => {
    const { state, request } = createState();
    request.mockImplementation(async (method: string) => {
      if (method === "skills.status") {
        return statusReport(undefined, [
          linkedSkill("weather", "alice"),
          linkedSkill("weather", "bob", 456),
        ]);
      }
      if (method === "skills.securityVerdicts") {
        return {
          schema: "openclaw.skills.security-verdicts.v1",
          items: [verdict("alice"), verdict("bob", false)],
        };
      }
      return {};
    });
    await loadSkills(state);
    const aliceKey = clawhubVerdictKey({
      registry: "https://clawhub.ai",
      slug: "weather",
      ownerHandle: "alice",
      version: "1.2.3",
    });
    const bobKey = clawhubVerdictKey({
      registry: "https://clawhub.ai",
      slug: "weather",
      ownerHandle: "bob",
      version: "1.2.3",
    });
    expect(aliceKey).not.toBe(bobKey);
    expect(Object.keys(state.clawhubVerdicts)).toHaveLength(2);
    expect(state.clawhubVerdicts[aliceKey]?.publisherHandle).toBe("alice");
    expect(state.clawhubVerdicts[bobKey]?.publisherHandle).toBe("bob");
  });

  it("ignores stale skill reports after switching agents mid-request", async () => {
    const { state, request } = createState();
    const alpha = createDeferred<unknown>();
    const beta = createDeferred<unknown>();
    request.mockReturnValueOnce(alpha.promise).mockReturnValueOnce(beta.promise);
    state.skillsAgentId = "alpha";
    state.skillEdits = { shared: "stale-secret" };
    const firstLoad = loadSkills(state);
    await Promise.resolve();
    setSkillsAgentId(state, "beta");
    expect(state.skillEdits).toEqual({});
    const secondLoad = loadSkills(state);
    await Promise.resolve();
    expect(request.mock.calls).toEqual([
      ["skills.status", { agentId: "alpha" }],
      ["skills.status", { agentId: "beta" }],
    ]);

    beta.resolve(
      statusReport("/tmp/beta", [{ name: "Beta", skillKey: "beta", source: "workspace" }]),
    );
    await secondLoad;

    alpha.resolve(
      statusReport("/tmp/alpha", [{ name: "Alpha", skillKey: "alpha", source: "workspace" }]),
    );
    await firstLoad;
    expect(state.skillsAgentId).toBe("beta");
    expect(state.skillsReport?.workspaceDir).toBe("/tmp/beta");
    expect(state.skillsReport?.skills.map((skill) => skill.name)).toEqual(["Beta"]);
    expect(state.skillsLoading).toBe(false);
  });

  it("ignores stale skill reports after switching away and back to the same agent", async () => {
    const { state, request } = createState();
    const queue = createDeferredRequestQueue(request);
    state.skillsAgentId = "alpha";
    const firstLoad = loadSkills(state);
    await Promise.resolve();
    setSkillsAgentId(state, "beta");
    setSkillsAgentId(state, "alpha");
    const secondLoad = loadSkills(state);
    await Promise.resolve();
    queue.resolveNext(
      statusReport("/tmp/stale-alpha", [
        { name: "Stale Alpha", skillKey: "stale-alpha", source: "workspace" },
      ]),
    );
    await firstLoad;
    expect(state.skillsReport).toBeNull();
    expect(state.skillsLoading).toBe(true);
    queue.resolveNext(
      statusReport("/tmp/current-alpha", [
        { name: "Current Alpha", skillKey: "current-alpha", source: "workspace" },
      ]),
    );
    await secondLoad;
    expect(state.skillsReport?.workspaceDir).toBe("/tmp/current-alpha");
    expect(state.skillsReport?.skills.map((skill) => skill.name)).toEqual(["Current Alpha"]);
    expect(state.skillsLoading).toBe(false);
  });

  it("releases loading ownership when the current client disconnects", async () => {
    const { state, request } = createState();
    const status = createDeferred<unknown>();
    request.mockReturnValue(status.promise);
    const load = loadSkills(state);
    await waitForFast(() => expect(state.skillsLoading).toBe(true));
    state.connected = false;
    status.reject(new Error("gateway disconnected"));
    await load;
    expect(state.skillsLoading).toBe(false);
    expect(state.skillsReport).toBeNull();
    expect(state.skillsError).toBeNull();
  });

  it("does not keep skills loading while the optional verdict refresh is pending", async () => {
    const { state, request } = createState();
    const verdicts = createDeferred<unknown>();
    request.mockImplementation((method: string) => {
      if (method === "skills.status") {
        return Promise.resolve(statusReport(undefined, [linkedSkill()]));
      }
      if (method === "skills.securityVerdicts") {
        return verdicts.promise;
      }
      return Promise.resolve({});
    });
    await loadSkills(state);
    expect(state.skillsLoading).toBe(false);
    expect(state.clawhubVerdictsLoading).toBe(true);

    verdicts.resolve({ schema: "openclaw.skills.security-verdicts.v1", items: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(state.clawhubVerdictsLoading).toBe(false);
  });

  it("drops cached Skill Card content when refreshed card metadata changes", async () => {
    const { state, request } = createState();
    state.skillCardContents = { agentreceipt: "old card" };
    state.skillCardContentKeys = {
      agentreceipt: "/tmp/workspace/skills/agentreceipt/skill-card.md\u000034\u00001.2.3",
    };
    request.mockResolvedValueOnce(createSkillCardReport("1.2.4", 456));
    await loadSkills(state);
    expect(state.skillCardContents.agentreceipt).toBeUndefined();
    expect(state.skillCardContentKeys.agentreceipt).toBeUndefined();
  });
});

describe("loadSkillCard", () => {
  it("loads local Skill Card content on demand", async () => {
    const { state, request } = createState();
    state.skillsAgentId = "research";
    request.mockResolvedValueOnce({
      skillKey: "agentreceipt",
      content: "# AgentReceipt\n\nLocal trust card.\n",
    });
    state.skillsReport = createSkillCardReport();
    await loadSkillCard(state, "agentreceipt");
    expect(request).toHaveBeenCalledWith("skills.skillCard", {
      agentId: "research",
      skillKey: "agentreceipt",
    });
    expect(state.skillCardContents.agentreceipt).toBe("# AgentReceipt\n\nLocal trust card.\n");
    expect(state.skillCardContentKeys.agentreceipt).toBe(
      "/tmp/workspace/skills/agentreceipt/skill-card.md\u000034\u0000",
    );
    expect(state.skillCardLoadingKey).toBeNull();
    expect(state.skillCardErrors).toEqual({});
  });

  it("does not cache stale Skill Card content after local metadata changes mid-request", async () => {
    const { state, request } = createState();
    const card = createDeferred<unknown>();
    request.mockReturnValue(card.promise);
    state.skillsReport = createSkillCardReport("1.2.3");
    const pending = loadSkillCard(state, "agentreceipt");
    state.skillsReport = createSkillCardReport("1.2.4", 456);
    card.resolve({
      skillKey: "agentreceipt",
      content: "old card",
    });
    await pending;
    expect(state.skillCardContents.agentreceipt).toBeUndefined();
    expect(state.skillCardContentKeys.agentreceipt).toBeUndefined();
  });
});

describe("searchClawHub", () => {
  it("requests the discovery feed when the query is empty", async () => {
    const { state, request } = createState();
    request.mockResolvedValue({ results: [] });
    await expect(searchClawHub(state.client!, "   ")).resolves.toEqual([]);
    expect(request).toHaveBeenCalledWith(
      "skills.search",
      { query: undefined, limit: 20 },
      { signal: undefined },
    );
  });
});

describe("loadClawHubDetail", () => {
  it("ignores stale detail responses after slug changes", async () => {
    const { state, request } = createState();
    const queue = createDeferredRequestQueue(request);
    const firstPending = loadClawHubDetail(state, "github");
    const secondPending = loadClawHubDetail(state, "gitlab");
    queue.resolveNext({
      skill: { slug: "github", displayName: "GitHub", createdAt: 1, updatedAt: 2 },
    });
    await firstPending;
    queue.resolveNext({
      skill: { slug: "gitlab", displayName: "GitLab", createdAt: 3, updatedAt: 4 },
    });
    await secondPending;
    expect(state.clawhubDetailLoading).toBe(false);
    expect(state.clawhubDetail?.skill?.slug).toBe("gitlab");
  });

  it("ignores a same-client detail response from an older connection epoch", async () => {
    const { state, request } = createState();
    const queue = createDeferredRequestQueue(request);
    const pending = loadClawHubDetail(state, "github");
    state.connected = false;
    state.skillsAgentRevision++;
    state.clawhubDetailLoading = false;
    state.connected = true;
    queue.resolveNext({
      skill: { slug: "stale", displayName: "Stale", createdAt: 1, updatedAt: 2 },
    });
    await pending;
    expect(state.clawhubDetail).toBeNull();
    expect(state.clawhubDetailLoading).toBe(false);
  });
});

describe("skill mutations", () => {
  it("reserves the shared operation while agent refresh is pending", async () => {
    const { state, request } = createState();
    request.mockResolvedValue(statusReport());
    const agents = createDeferred();
    const loadAgents = vi.fn(() => agents.promise);
    const overlappingLoadAgents = vi.fn(async () => undefined);
    const refresh = refreshSkills(state, loadAgents);
    await waitForFast(() => expect(state.skillOperation).toEqual({ kind: "refresh" }));
    await refreshSkills(state, overlappingLoadAgents);
    await updateSkillEnabled(state, "github", true);
    expect(overlappingLoadAgents).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    agents.resolve();
    await refresh;
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("skills.status", { agentId: "main" });
    expect(state.skillOperation).toBeNull();
  });

  it("retries a refresh when agent reconciliation changes scope", async () => {
    const { state, request } = createState();
    const queue = createDeferredRequestQueue(request);
    state.skillsAgentId = "alpha";
    const refresh = refreshSkills(state, async () => undefined);
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    setSkillsAgentId(state, "beta");
    queue.resolveNext(statusReport("/tmp/alpha"));
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    queue.resolveNext(statusReport("/tmp/beta"));
    await refresh;
    expect(request.mock.calls).toEqual([
      ["skills.status", { agentId: "alpha" }],
      ["skills.status", { agentId: "beta" }],
    ]);
    expect(state.skillsReport?.workspaceDir).toBe("/tmp/beta");
    expect(state.skillOperation).toBeNull();
  });

  it("saves API keys and reports success", async () => {
    const { state, request } = createState();
    state.skillsAgentId = "research";
    request.mockResolvedValue({});
    state.skillEdits.github = "  sk-test  ";
    await saveSkillApiKey(state, "github");
    expect(request).toHaveBeenCalledWith("skills.update", {
      skillKey: "github",
      apiKey: "sk-test",
    });
    expect(state.skillMessages.github).toEqual({
      kind: "success",
      message: "API key saved — stored in openclaw.json (skills.entries.github)",
    });
    expect(state.skillOperation).toBeNull();
    expect(state.skillsError).toBeNull();
  });

  it("does not clear an existing API key when its replacement is blank", async () => {
    const { state, request } = createState();
    state.skillEdits.github = "   ";
    await saveSkillApiKey(state, "github");
    expect(request).not.toHaveBeenCalled();
    expect(state.skillMessages.github).toBeUndefined();
    expect(state.skillOperation).toBeNull();
  });

  it("config.set serializes skill changes after pending settings drafts and refreshes both owners", async () => {
    const { state, request } = createState();
    const methods: string[] = [];
    let storedConfig: Record<string, unknown> = { count: 1 };
    let hash = "hash-1";
    request.mockImplementation(async (method, params) => {
      methods.push(method);
      if (method === "config.get") {
        return {
          config: storedConfig,
          raw: JSON.stringify(storedConfig),
          hash,
          valid: true,
          issues: [],
        };
      }
      if (method === "config.set") {
        storedConfig = JSON.parse((params as { raw: string }).raw) as Record<string, unknown>;
        hash = "hash-2";
        return { config: storedConfig, hash };
      }
      if (method === "skills.update") {
        storedConfig = { ...storedConfig, skillEnabled: true };
        hash = "hash-3";
        return {};
      }
      return statusReport();
    });
    const runtimeConfig = await attachRuntimeConfig(state);
    methods.length = 0;

    try {
      runtimeConfig.patchForm(["count"], 2);
      await updateSkillEnabled(state, "github", true);

      expect(methods).toEqual(["config.set", "skills.update", "config.get", "skills.status"]);
      expect(runtimeConfig.state.configForm).toEqual({ count: 2, skillEnabled: true });
      expect(state.skillMessages.github).toEqual({ kind: "success", message: "Skill enabled" });
    } finally {
      runtimeConfig.dispose();
    }
  });

  it("config.set does not dispatch a queued skill update after access changes", async () => {
    const { state, request } = createState();
    const firstSet = createDeferred<unknown>();
    const methods: string[] = [];
    let canDispatch = true;
    request.mockImplementation((method) => {
      methods.push(method);
      if (method === "config.get") {
        return Promise.resolve({
          config: { count: 1 },
          raw: '{"count":1}',
          hash: "hash-1",
          valid: true,
          issues: [],
        });
      }
      if (method === "config.set") {
        return firstSet.promise;
      }
      return Promise.resolve(statusReport());
    });
    const runtimeConfig = await attachRuntimeConfig(state);
    methods.length = 0;

    try {
      runtimeConfig.patchForm(["count"], 2);
      const mutation = updateSkillEnabled(state, "github", true, () => canDispatch);
      await waitForFast(() => expect(methods).toEqual(["config.set"]));
      canDispatch = false;
      firstSet.resolve({ config: { count: 2 }, hash: "hash-2" });
      await mutation;

      expect(methods).toEqual(["config.set"]);
      expect(state.skillMessages.github).toEqual({
        kind: "error",
        message: "Access changed before the skill update started.",
      });
    } finally {
      runtimeConfig.dispose();
    }
  });

  it("reports a committed skill update when its configuration refresh fails", async () => {
    const { state, request } = createState();
    state.runtimeConfig.runExternalMutation = async (task) => ({
      ok: true,
      value: await task(expectDefined(state.client, "connected skill mutation client")),
      refresh: { ok: false, error: "Configuration refresh failed" },
    });
    request.mockResolvedValue({});
    await updateSkillEnabled(state, "github", true);
    expect(state.skillMessages.github).toEqual({
      kind: "success",
      message: "Skill enabled\nConfiguration refresh failed",
    });
  });

  it.each([
    {
      name: "skill update blocks ClawHub install",
      firstMethod: "skills.update",
      start: (state: SkillsState) => updateSkillEnabled(state, "github", true),
      blocked: (state: SkillsState) => installFromClawHub(state, "calendar"),
      expectedMutation: { kind: "skill", skillKey: "github" } as const,
    },
    {
      name: "ClawHub install blocks skill update",
      firstMethod: "skills.install",
      start: (state: SkillsState) => installFromClawHub(state, "github"),
      blocked: (state: SkillsState) => updateSkillEnabled(state, "calendar", true),
      expectedMutation: { kind: "clawhub", ref: "github" } as const,
    },
  ])("serializes $name and locks API key edits", async (fixture) => {
    const { state, request } = createState();
    const firstResult = createDeferred<unknown>();
    request.mockImplementation(async (method) => {
      if (method === fixture.firstMethod) {
        return firstResult.promise;
      }
      return method === "skills.status" ? statusReport() : {};
    });
    state.skillEdits.github = "submitted-value";
    const first = fixture.start(state);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(1));
    expect(state.skillOperation).toEqual(fixture.expectedMutation);
    await fixture.blocked(state);
    updateSkillEdit(state, "github", "late-value");
    expect(request).toHaveBeenCalledTimes(1);
    expect(state.skillEdits.github).toBe("submitted-value");

    firstResult.resolve({});
    await first;
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      fixture.firstMethod,
      "skills.status",
    ]);
    expect(state.skillOperation).toBeNull();
  });

  it("rejects mutations while a status refresh is active", async () => {
    const { state, request } = createState();
    state.skillsLoading = true;
    state.skillEdits.github = "submitted-value";
    await updateSkillEnabled(state, "github", true);
    await installFromClawHub(state, "github");
    updateSkillEdit(state, "github", "late-value");
    expect(request).not.toHaveBeenCalled();
    expect(state.skillEdits.github).toBe("submitted-value");
    expect(state.skillOperation).toBeNull();
  });

  it("drops an old-client mutation continuation without releasing the current owner", async () => {
    const { state, request: oldRequest } = createState();
    const oldMutationResult = createDeferred<unknown>();
    oldRequest.mockReturnValue(oldMutationResult.promise);
    const oldMutation = updateSkillEnabled(state, "github", true);
    await waitForFast(() => expect(oldRequest).toHaveBeenCalledOnce());
    const currentMutationResult = createDeferred<unknown>();
    const currentRequest = vi.fn<TestRequest>((method) =>
      method === "skills.update"
        ? currentMutationResult.promise
        : Promise.resolve(statusReport("/tmp/current")),
    );
    state.client = { request: currentRequest } as unknown as SkillsState["client"];
    state.skillsAgentRevision += 1;
    state.skillOperation = null;
    const currentMutation = updateSkillEnabled(state, "calendar", true);
    await waitForFast(() => expect(currentRequest).toHaveBeenCalledOnce());
    const currentOperation = state.skillOperation;

    oldMutationResult.resolve({});
    await oldMutation;
    expect(state.skillOperation).toBe(currentOperation);

    currentMutationResult.resolve({});
    await currentMutation;
    expect(currentRequest.mock.calls.map(([method]) => method)).toEqual([
      "skills.update",
      "skills.status",
    ]);
    expect(state.skillsReport?.workspaceDir).toBe("/tmp/current");
    expect(state.skillOperation).toBeNull();
  });

  it("records errors from failed mutations", async () => {
    const { state, request } = createState();
    request.mockRejectedValue(new Error("skills update failed"));
    await updateSkillEnabled(state, "github", false);
    expect(state.skillsError).toBe("skills update failed");
    expect(state.skillMessages.github).toEqual({
      kind: "error",
      message: "skills update failed",
    });
    expect(state.skillOperation).toBeNull();
  });

  it("defers a new agent refresh until a stale global config mutation succeeds", async () => {
    const { state, request } = createState();
    const queue = createDeferredRequestQueue(request);
    state.skillsAgentId = "alpha";
    const mutation = updateSkillEnabled(state, "github", true);
    await Promise.resolve();
    setSkillsAgentId(state, "beta");
    const betaLoad = loadSkills(state);
    await Promise.resolve();
    await betaLoad;
    expect(request).toHaveBeenCalledTimes(1);
    queue.resolveNext({});
    await waitForFast(() => {
      expect(request).toHaveBeenCalledTimes(2);
    });
    queue.resolveNext(statusReport("/tmp/beta-after-update"));
    await mutation;
    expect(request.mock.calls).toEqual([
      ["skills.update", { skillKey: "github", enabled: true }],
      ["skills.status", { agentId: "beta" }],
    ]);
    expect(state.skillsReport?.workspaceDir).toBe("/tmp/beta-after-update");
    expect(state.skillMessages).toEqual({});
  });

  it("loads the current agent after a stale mutation fails", async () => {
    const { state, request } = createState();
    const update = createDeferred<unknown>();
    request.mockImplementation((method) => {
      if (method === "skills.update") {
        return update.promise;
      }
      return Promise.resolve(statusReport("/tmp/beta-after-error"));
    });
    state.skillsAgentId = "alpha";
    const mutation = updateSkillEnabled(state, "github", true);
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    setSkillsAgentId(state, "beta");
    update.reject(new Error("stale update failed"));
    await mutation;
    expect(request.mock.calls).toEqual([
      ["skills.update", { skillKey: "github", enabled: true }],
      ["skills.status", { agentId: "beta" }],
    ]);
    expect(state.skillsReport?.workspaceDir).toBe("/tmp/beta-after-error");
    expect(state.skillsError).toBeNull();
    expect(state.skillMessages).toEqual({});
  });

  it("shows ClawHub trust warnings returned by successful skill installs", async () => {
    const { state, request } = createState();
    request.mockImplementation(async (method: string) => {
      if (method === "skills.install") {
        return {
          message: "Installed github@1.2.3",
          warning: "REVIEW RECOMMENDED - ClawHub has not completed a fresh clean check",
        };
      }
      return {};
    });
    await installFromClawHub(state, "github");
    expect(state.clawhubInstallMessage).toEqual({
      kind: "success",
      text:
        "Installed github@1.2.3\n\n" +
        "REVIEW RECOMMENDED - ClawHub has not completed a fresh clean check",
    });
  });

  it("shows a ClawHub trust error without an acknowledgement retry", async () => {
    const { state, request } = createState();
    const message = "ClawHub requires acknowledgement before installing.";
    const details = {
      clawhubTrustCode: "clawhub_risk_acknowledgement_required",
      version: "1.2.3",
      warning: "REVIEW REQUIRED - ClawHub found suspicious behavior.",
    };
    request.mockRejectedValue(Object.assign(new Error(message), { details }));
    await installFromClawHub(state, "github");
    expect(request).toHaveBeenCalledOnce();
    expect(state.clawhubInstallMessage).toEqual({
      kind: "error",
      text: `${message}\n\n${details.warning}`,
    });
  });

  it.each([
    {
      name: "legacy install",
      run: (state: SkillsState) => installSkill(state, "github", "GitHub", "install-123"),
      expectedRequest: {
        agentId: "alpha",
        name: "GitHub",
        installId: "install-123",
        dangerouslyForceUnsafeInstall: false,
      },
    },
    {
      name: "ClawHub install",
      run: (state: SkillsState) => installFromClawHub(state, "github"),
      expectedRequest: {
        agentId: "alpha",
        source: "clawhub",
        slug: "github",
      },
    },
  ])(
    "refreshes the current scope after switching during $name",
    async ({ run, expectedRequest }) => {
      const { state, request } = createState();
      const queue = createDeferredRequestQueue(request);
      state.skillsAgentId = "alpha";

      const pending = run(state);
      await Promise.resolve();
      setSkillsAgentId(state, "beta");
      queue.resolveNext({ message: "Installed" });
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
      queue.resolveNext(statusReport("/tmp/beta-after-install"));
      await pending;

      expect(request).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenNthCalledWith(1, "skills.install", expectedRequest);
      expect(request).toHaveBeenNthCalledWith(2, "skills.status", { agentId: "beta" });
      expect(state.skillsAgentId).toBe("beta");
      expect(state.skillsReport?.workspaceDir).toBe("/tmp/beta-after-install");
      expect(state.skillMessages).toEqual({});
      expect(state.clawhubInstallMessage).toBeNull();
      expect(state.skillOperation).toBeNull();
    },
  );
});

describe("reconcileSkillsAgentId", () => {
  it("selects the roster default after the selected agent is deleted", () => {
    const { state } = createState();
    state.skillsAgentId = "deleted";
    state.skillsReport = {
      workspaceDir: "/tmp/deleted",
      managedSkillsDir: "/tmp/skills",
      skills: [],
    };
    state.skillOperation = { kind: "clawhub", ref: "calendar" };

    reconcileSkillsAgentId(state, {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }],
    });
    expect(state.skillsAgentId).toBe("main");
    expect(state.skillsAgentRevision).toBe(1);
    expect(state.skillsReport).toBeNull();
    expect(state.skillOperation).toEqual({ kind: "clawhub", ref: "calendar" });
  });
});
