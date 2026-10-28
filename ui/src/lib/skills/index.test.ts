// @vitest-environment node
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SkillStatusReport } from "../../api/types.ts";
import { makeBootRoster } from "../../app/bootstrap.test-support.ts";
import { createProps, createSkill } from "../../pages/skills/view.test-support.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { configSnapshot } from "../config/config-snapshot.test-support.ts";
import { createRuntimeConfigCapability } from "../config/runtime-config-capability.ts";
import { searchClawHub } from "./clawhub-search.ts";
import { createDeferredRequestQueue, type TestRequest } from "./index.test-support.ts";
import {
  installFromClawHub,
  installSkill,
  loadSkills,
  loadSkillCard,
  loadClawHubDetail,
  loadClawHubSecurityVerdicts,
  refreshSkills,
  reconcileSkillsAgentId,
  saveSkillApiKey,
  setSkillsAgentId,
  updateSkillEdit,
  updateSkillEnabled,
} from "./index.ts";

type SkillsState = Parameters<typeof loadSkills>[0];

let state: SkillsState;
let request: ReturnType<typeof vi.fn<TestRequest>>;
beforeEach(() => {
  request = vi.fn<TestRequest>();
  state = createProps({ report: null, clawhubResults: [] }).state;
  state.skillsAgentId = "main";
  state.client = { request } as unknown as SkillsState["client"];
  state.runtimeConfig = {
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
  };
});

function statusReport(
  workspaceDir = "/tmp/workspace",
  skills: SkillStatusReport["skills"] = [],
): SkillStatusReport {
  return { workspaceDir, managedSkillsDir: "/tmp/skills", skills };
}

async function attachRuntimeConfig(subject: SkillsState) {
  const runtimeConfig = createRuntimeConfigCapability({
    snapshot: {
      client: expectDefined(subject.client, "connected skill mutation client"),
      phase: "connected",
      sessionKey: "main",
      hello: gatewayHelloForMethods(["config.set"]),
    },
    subscribe: () => () => undefined,
  });
  subject.runtimeConfig = runtimeConfig;
  onTestFinished(() => runtimeConfig.dispose());
  await runtimeConfig.ensureLoaded();
  return runtimeConfig;
}

function linkedSkill(slug = "agentreceipt", ownerHandle?: string, installedVersion = "1.2.3") {
  return createSkill({
    skillKey: ownerHandle ? `${ownerHandle}-${slug}` : slug,
    clawhub: {
      status: "linked",
      valid: true,
      registry: "https://clawhub.ai",
      slug,
      ownerHandle,
      installedVersion,
      installedAt: 123,
      originPath: "/tmp/origin.json",
      lockPath: "/tmp/lock.json",
    },
  });
}

function verdict(ownerHandle?: string, passed = true) {
  const slug = ownerHandle ? "weather" : "agentreceipt";
  return {
    registry: "https://clawhub.ai",
    ok: passed,
    decision: passed ? "pass" : "fail",
    requestedSlug: slug,
    requestedOwnerHandle: ownerHandle,
    requestedVersion: "1.2.3",
    publisherHandle: ownerHandle,
    securityStatus: passed ? "clean" : "suspicious",
    securityPassed: passed,
  };
}

function createSkillCardReport(installedVersion?: string): SkillStatusReport {
  const skill = installedVersion
    ? linkedSkill("agentreceipt", undefined, installedVersion)
    : createSkill({ skillKey: "agentreceipt" });
  skill.skillCard = { present: true, path: "/tmp/card.md", sizeBytes: 34 };
  return { ...statusReport(), skills: [skill] };
}

describe("loadSkills", () => {
  it.each(["inventory", "verdicts", "card"] as const)(
    "releases the retired %s read before its transport settles",
    async (kind) => {
      const pending = createDeferred<unknown>();
      request.mockReturnValue(pending.promise);
      state.skillsReport = createSkillCardReport("1.2.3");
      const task =
        kind === "inventory"
          ? loadSkills(state)
          : kind === "verdicts"
            ? loadClawHubSecurityVerdicts(state, state.skillsReport)
            : loadSkillCard(state, "agentreceipt");
      const completion =
        kind === "inventory"
          ? state.skillsRead?.completion
          : kind === "verdicts"
            ? state.clawhubVerdictsRead?.completion
            : state.skillCardReads.agentreceipt?.completion;
      let settled = false;
      void expectDefined(completion, "admitted skill read").then(() => {
        settled = true;
      });
      setSkillsAgentId(state, "research");
      await Promise.resolve();
      expect(settled).toBe(true);
      expect(state.skillsReport).toBeNull();
      pending.resolve(
        kind === "inventory"
          ? createSkillCardReport("1.2.3")
          : kind === "verdicts"
            ? { items: [verdict()] }
            : { skillKey: "agentreceipt", content: "Retired card" },
      );
      await task;
      expect(state.skillsReport).toBeNull();
      expect(state.clawhubVerdicts).toEqual({});
      expect(state.skillCardContents).toEqual({});
    },
  );

  it("does not issue an ownerless status request", async () => {
    state.skillsAgentId = null;
    await loadSkills(state);
    expect(request).not.toHaveBeenCalled();
  });

  it("batches verdicts without conflating installed owners", async () => {
    state.skillsAgentId = "research";
    const owners = [undefined, "alice", "bob"];
    const items = owners.map((owner, i) => verdict(owner, i !== 2));
    request
      .mockResolvedValueOnce(
        statusReport("/tmp/research", [
          ...owners.map((owner) => linkedSkill(owner ? "weather" : "agentreceipt", owner)),
          createSkill({ name: "Local", skillKey: "local", source: "workspace" }),
        ]),
      )
      .mockResolvedValueOnce({ items });
    await loadSkills(state);
    expect(request.mock.calls).toEqual([
      ["skills.status", { agentId: "research" }],
      ["skills.securityVerdicts", { agentId: "research" }],
    ]);
    const keys = [
      "https://clawhub.ai\0\0agentreceipt\u00001.2.3",
      "https://clawhub.ai\0alice\0weather\u00001.2.3",
      "https://clawhub.ai\0bob\0weather\u00001.2.3",
    ];
    expect(Object.keys(state.clawhubVerdicts)).toEqual(keys);
    expect(Object.values(state.clawhubVerdicts)).toEqual(items);
    expect(state.skillsReport?.workspaceDir).toBe("/tmp/research");
    expect(state.clawhubVerdictsError).toBeNull();
  });

  it("rejects an older report after returning to the same agent", async () => {
    const queue = createDeferredRequestQueue(request);
    state.skillsAgentId = "alpha";
    state.skillEdits = { shared: "stale-secret" };
    const old = loadSkills(state);
    setSkillsAgentId(state, "beta");
    setSkillsAgentId(state, "alpha");
    expect(state.skillEdits).toEqual({});
    const current = loadSkills(state);
    queue.resolveNext(statusReport("/tmp/stale"));
    await old;
    expect(state.skillsReport).toBeNull();
    expect(state.skillsLoading).toBe(true);
    queue.resolveNext(statusReport("/tmp/current"));
    await current;
    expect(state.skillsReport?.workspaceDir).toBe("/tmp/current");
    expect(state.skillsLoading).toBe(false);
  });

  it("releases loading ownership when the current client disconnects", async () => {
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

  it("drops cached Skill Card content when refreshed card metadata changes", async () => {
    state.skillCardContents = { agentreceipt: "old card" };
    state.skillCardContentKeys = {
      agentreceipt: "/tmp/card.md\u000034\u00001.2.3",
    };
    request.mockResolvedValueOnce(createSkillCardReport("1.2.4"));
    await loadSkills(state);
    expect(state.skillCardContents.agentreceipt).toBeUndefined();
    expect(state.skillCardContentKeys.agentreceipt).toBeUndefined();
  });
});

describe("loadSkillCard", () => {
  it("joins an admitted card read after selecting another card and reuses empty cached content", async () => {
    const first = createDeferred<unknown>();
    const second = createDeferred<unknown>();
    request
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValue(first.promise);
    const report = createSkillCardReport();
    const original = report.skills[0]!;
    state.skillsReport = {
      ...report,
      skills: [
        original,
        {
          ...original,
          skillKey: "second-card",
          skillCard: { ...original.skillCard!, path: "/tmp/second-card.md" },
        },
      ],
    };
    const originalRead = loadSkillCard(state, "agentreceipt");
    const otherRead = loadSkillCard(state, "second-card");
    const revisited = loadSkillCard(state, "agentreceipt");
    let revisitedSettled = false;
    void revisited.then(() => {
      revisitedSettled = true;
    });
    await Promise.resolve();
    expect(revisitedSettled).toBe(false);
    first.resolve({ skillKey: "agentreceipt", content: "# First card" });
    second.resolve({ skillKey: "second-card", content: "" });
    await Promise.all([originalRead, otherRead, revisited]);
    await loadSkillCard(state, "second-card");
    expect(request.mock.calls).toEqual([
      ["skills.skillCard", { agentId: "main", skillKey: "agentreceipt" }],
      ["skills.skillCard", { agentId: "main", skillKey: "second-card" }],
    ]);
    expect(state.skillCardContents).toEqual({ agentreceipt: "# First card", "second-card": "" });
    expect(state.skillCardContentKeys.agentreceipt).toBe("/tmp/card.md\u000034\u0000");
    expect(state.skillCardErrors).toEqual({});
  });

  it.each([false, true])(
    "rejects changed card metadata (replacement read: %s)",
    async (replace) => {
      const old = createDeferred<unknown>();
      const fresh = createDeferred<unknown>();
      request.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
      state.skillsReport = createSkillCardReport("1.2.3");
      const oldRead = loadSkillCard(state, "agentreceipt");
      state.skillsReport = createSkillCardReport("1.2.4");
      const freshRead = replace ? loadSkillCard(state, "agentreceipt") : undefined;
      old.resolve({ skillKey: "agentreceipt", content: "Old version" });
      await oldRead;
      expect(state.skillCardContents.agentreceipt).toBeUndefined();
      expect(state.skillCardContentKeys.agentreceipt).toBeUndefined();
      if (replace) {
        fresh.resolve({ skillKey: "agentreceipt", content: "Fresh version" });
        await freshRead;
        expect(state.skillCardContents.agentreceipt).toBe("Fresh version");
      }
    },
  );
});

it("requests the discovery feed when the query is empty", async () => {
  request.mockResolvedValue({ results: [] });
  await expect(searchClawHub(state.client!, "   ")).resolves.toEqual([]);
  expect(request).toHaveBeenCalledWith(
    "skills.search",
    { query: undefined, limit: 20 },
    { signal: undefined },
  );
});

it("ignores stale detail responses after slug changes", async () => {
  const queue = createDeferredRequestQueue(request);
  const firstPending = loadClawHubDetail(state, "github");
  const secondPending = loadClawHubDetail(state, "gitlab");
  queue.resolveNext({
    skill: { slug: "github", displayName: "GitHub", createdAt: 1, updatedAt: 2 },
  });
  await firstPending;
  expect(state.clawhubDetail).toBeNull();
  queue.resolveNext({
    skill: { slug: "gitlab", displayName: "GitLab", createdAt: 3, updatedAt: 4 },
  });
  await secondPending;
  expect(state.clawhubDetail?.skill?.slug).toBe("gitlab");
});

it("ignores a same-client detail response from an older connection epoch", async () => {
  const queue = createDeferredRequestQueue(request);
  const pending = loadClawHubDetail(state, "github");
  state.connected = false;
  state.skillsAgentRevision++;
  state.connected = true;
  queue.resolveNext({
    skill: { slug: "stale", displayName: "Stale", createdAt: 1, updatedAt: 2 },
  });
  await pending;
  expect(state.clawhubDetail).toBeNull();
});

describe("skill mutations", () => {
  it("reserves the shared operation while agent refresh is pending", async () => {
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
    expect(request).toHaveBeenCalledWith("skills.status", { agentId: "main" });
    expect(state.skillOperation).toBeNull();
  });

  it("retries a refresh when agent reconciliation changes scope", async () => {
    const queue = createDeferredRequestQueue(request);
    state.skillsAgentId = "alpha";
    const refresh = refreshSkills(state, async () => undefined);
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    setSkillsAgentId(state, "beta");
    queue.resolveNext(statusReport("/tmp/alpha"));
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    queue.resolveNext(statusReport("/tmp/beta"));
    await refresh;
    expect(state.skillsReport?.workspaceDir).toBe("/tmp/beta");
    expect(state.skillOperation).toBeNull();
  });

  it("saves API keys and reports success", async () => {
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
  });

  it("does not clear an existing API key when its replacement is blank", async () => {
    state.skillEdits.github = "   ";
    await saveSkillApiKey(state, "github");
    expect(request).not.toHaveBeenCalled();
    expect(state.skillMessages.github).toBeUndefined();
    expect(state.skillOperation).toBeNull();
  });

  it.each([false, true])("serializes config writes (revoke access: %s)", async (revoke) => {
    const firstSet = createDeferred<unknown>();
    const methods: string[] = [];
    let config: Record<string, unknown> = { count: 1 };
    let hash = "hash-1";
    let canDispatch = true;
    request.mockImplementation(async (method, params) => {
      methods.push(method);
      if (method === "config.get") {
        return configSnapshot(config, hash, JSON.stringify(config));
      }
      if (method === "config.set") {
        await firstSet.promise;
        config = JSON.parse((params as { raw: string }).raw) as Record<string, unknown>;
        hash = "hash-2";
        return { config, hash };
      }
      if (method === "skills.update") {
        config = { ...config, skillEnabled: true };
        hash = "hash-3";
        return {};
      }
      return statusReport();
    });
    const runtimeConfig = await attachRuntimeConfig(state);
    methods.length = 0;
    runtimeConfig.patchForm(["count"], 2);
    const mutation = updateSkillEnabled(state, "github", true, () => canDispatch);
    await waitForFast(() => expect(methods).toEqual(["config.set"]));
    canDispatch = !revoke;
    firstSet.resolve({});
    await mutation;
    expect(methods).toEqual(
      revoke ? ["config.set"] : ["config.set", "skills.update", "config.get", "skills.status"],
    );
    expect(runtimeConfig.state.configForm).toEqual(
      revoke ? { count: 2 } : { count: 2, skillEnabled: true },
    );
    expect(state.skillMessages.github).toEqual(
      revoke
        ? { kind: "error", message: "Access changed before the skill update started." }
        : { kind: "success", message: "Skill enabled" },
    );
  });

  it("reports a committed skill update when its configuration refresh fails", async () => {
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

  it.each(["skills.update", "skills.install"] as const)(
    "serializes %s and locks edits",
    async (firstMethod) => {
      const firstResult = createDeferred<unknown>();
      request.mockImplementation(async (method) => {
        if (method === firstMethod) {
          return firstResult.promise;
        }
        return method === "skills.status" ? statusReport() : {};
      });
      state.skillEdits.github = "submitted-value";
      const first =
        firstMethod === "skills.update"
          ? updateSkillEnabled(state, "github", true)
          : installFromClawHub(state, "github");
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(1));
      if (firstMethod === "skills.update") {
        await installFromClawHub(state, "calendar");
      } else {
        await updateSkillEnabled(state, "calendar", true);
      }
      updateSkillEdit(state, "github", "late-value");
      expect(request).toHaveBeenCalledTimes(1);
      expect(state.skillEdits.github).toBe("submitted-value");

      firstResult.resolve({});
      await first;
      expect(state.skillOperation).toBeNull();
    },
  );

  it("rejects mutations while a status refresh is active", async () => {
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
    const oldRequest = request;
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
    expect(state.skillsReport?.workspaceDir).toBe("/tmp/current");
    expect(state.skillOperation).toBeNull();
  });

  it("records errors from failed mutations", async () => {
    request.mockRejectedValue(new Error("skills update failed"));
    await updateSkillEnabled(state, "github", false);
    expect(state.skillsError).toBe("skills update failed");
    expect(state.skillMessages.github).toEqual({
      kind: "error",
      message: "skills update failed",
    });
    expect(state.skillOperation).toBeNull();
  });

  it.each([false, true])(
    "refreshes the new agent after stale mutation (failure: %s)",
    async (fails) => {
      const update = createDeferred<unknown>();
      const report = createDeferred<unknown>();
      request.mockImplementation((method) =>
        method === "skills.update" ? update.promise : report.promise,
      );
      state.skillsAgentId = "alpha";
      const mutation = updateSkillEnabled(state, "github", true);
      await waitForFast(() => expect(request).toHaveBeenCalledOnce());
      setSkillsAgentId(state, "beta");
      await loadSkills(state);
      expect(request).toHaveBeenCalledOnce();
      if (fails) {
        update.reject(new Error("stale update failed"));
      } else {
        update.resolve({});
      }
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
      report.resolve(statusReport("/tmp/beta"));
      await mutation;
      expect(state).toMatchObject({
        skillsReport: { workspaceDir: "/tmp/beta" },
        skillsError: null,
      });
      expect(state.skillMessages).toEqual({});
    },
  );

  it("shows ClawHub trust warnings returned by successful skill installs", async () => {
    const warning = "REVIEW RECOMMENDED - ClawHub has not completed a fresh clean check";
    request
      .mockResolvedValueOnce({ message: "Installed github@1.2.3", warning })
      .mockResolvedValue({});
    await installFromClawHub(state, "github");
    expect(state.clawhubInstallMessage).toEqual({
      kind: "success",
      text: `Installed github@1.2.3\n\n${warning}`,
    });
  });

  it("shows a ClawHub trust error without an acknowledgement retry", async () => {
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
    ["legacy", { name: "GitHub", installId: "install-123", dangerouslyForceUnsafeInstall: false }],
    ["clawhub", { source: "clawhub", slug: "github" }],
  ] as const)("refreshes the new scope during %s install", async (kind, params) => {
    const queue = createDeferredRequestQueue(request);
    state.skillsAgentId = "alpha";

    const pending =
      kind === "legacy"
        ? installSkill(state, "github", "GitHub", "install-123")
        : installFromClawHub(state, "github");
    await Promise.resolve();
    setSkillsAgentId(state, "beta");
    queue.resolveNext({ message: "Installed" });
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    queue.resolveNext(statusReport("/tmp/beta-after-install"));
    await pending;

    expect(request).toHaveBeenNthCalledWith(1, "skills.install", { agentId: "alpha", ...params });
    expect(request).toHaveBeenNthCalledWith(2, "skills.status", { agentId: "beta" });
    expect(state.skillsAgentId).toBe("beta");
    expect(state.skillsReport?.workspaceDir).toBe("/tmp/beta-after-install");
    expect(state.skillMessages).toEqual({});
    expect(state.clawhubInstallMessage).toBeNull();
    expect(state.skillOperation).toBeNull();
  });
});

it("retires presentation before selecting the roster default after the selected agent is deleted", () => {
  state.skillsAgentId = "deleted";
  state.skillsReport = statusReport("/tmp/deleted");
  state.skillOperation = { kind: "clawhub", ref: "calendar" };
  const beforeRetarget = vi.fn(() => {
    expect(state.skillsAgentId).toBe("deleted");
    expect(state.skillsAgentRevision).toBe(0);
    expect(state.skillsReport?.workspaceDir).toBe("/tmp/deleted");
  });
  setSkillsAgentId(state, " deleted ", beforeRetarget);
  expect(beforeRetarget).not.toHaveBeenCalled();

  reconcileSkillsAgentId(state, makeBootRoster(), beforeRetarget);
  expect(beforeRetarget).toHaveBeenCalledTimes(1);
  expect(state.skillsAgentId).toBe("main");
  expect(state.skillsAgentRevision).toBe(1);
  expect(state.skillsReport).toBeNull();
  expect(state.skillOperation).toEqual({ kind: "clawhub", ref: "calendar" });
});
