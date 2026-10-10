// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readDraftCloudProfiles, readDraftEnvironments } from "./discovery.ts";

describe("readDraftCloudProfiles", () => {
  it("projects only bounded display identity and never guesses from a profile name", () => {
    expect(
      readDraftCloudProfiles([
        {
          id: "production",
          providerId: "crabbox",
          providerDisplayId: "aws",
          settings: { provider: "azure" },
        },
        { id: "aws", providerId: "crabbox", providerDisplayId: "azure" },
      ]),
    ).toEqual([
      { id: "aws", providerId: "crabbox", providerDisplayId: "azure", trust: undefined },
      { id: "production", providerId: "crabbox", providerDisplayId: "aws", trust: undefined },
    ]);
    for (const providerDisplayId of [undefined, "", " aws", "aws\n", "a".repeat(65), {}, 42]) {
      const [profile] = readDraftCloudProfiles([
        { id: "aws", providerId: "crabbox", providerDisplayId },
      ]);
      expect(profile).not.toHaveProperty("providerDisplayId");
    }
  });

  it("keeps same-class choices distinct per OS and bounds catalogs", () => {
    const [profile] = readDraftCloudProfiles([
      {
        id: "aws",
        providerId: "crabbox",
        operatingSystems: [
          { id: "linux", label: "Linux", default: true },
          {
            id: "windows/wsl2",
            label: "Windows (WSL2)",
            disabledReason: "Upgrade the worker provider.",
          },
          { id: "linux", label: "Duplicate" },
        ],
        machines: [
          { id: "tiny", label: "Tiny Linux", os: "linux" },
          { id: "tiny", label: "Duplicate", os: "linux" },
          { id: "tiny", label: "Tiny Windows", os: "windows/wsl2" },
          ...Array.from({ length: 64 }, (_, index) => ({
            id: `class-${index}`,
            label: `Class ${index}`,
          })),
        ],
      },
    ]);
    expect(profile?.operatingSystems).toEqual([
      { id: "linux", label: "Linux", default: true },
      {
        id: "windows/wsl2",
        label: "Windows (WSL2)",
        disabledReason: "Upgrade the worker provider.",
      },
    ]);
    expect(profile?.machines?.slice(0, 2)).toEqual([
      { id: "tiny", label: "Tiny Linux", os: "linux" },
      { id: "tiny", label: "Tiny Windows", os: "windows/wsl2" },
    ]);
    expect(profile?.machines).toHaveLength(63);
  });

  it("keeps closed profile summaries in stable order", () => {
    expect(
      readDraftCloudProfiles([
        null,
        42,
        {
          id: " zeta ",
          providerId: " static-ssh ",
          trust: "disposable",
          executionMode: "worker-turn",
          settings: { token: "hidden" },
        },
        {
          id: "aws",
          providerId: "crabbox",
          trust: "persistent",
          executionMode: "worker-turn",
          executionModes: ["worker-turn", "remote-exec"],
          machines: [
            {
              id: "standard",
              label: "Standard",
              cpu: 32,
              memoryGb: 64,
              default: true,
            },
            { id: "fast", label: "Fast", cpu: 0, memoryGb: 127.5 },
            { id: "fast", label: "Duplicate" },
            { id: "", label: "Invalid" },
          ],
        },
        { id: "legacy", providerId: "static-ssh" },
        {
          id: "invalid-trust",
          providerId: "crabbox",
          trust: "temporary",
          executionMode: "sandbox",
        },
        { id: "", providerId: "crabbox" },
        { id: "missing-provider" },
      ]),
    ).toEqual([
      {
        id: "aws",
        providerId: "crabbox",
        trust: "persistent",
        executionModes: ["worker-turn", "remote-exec"],
        machines: [
          {
            id: "standard",
            label: "Standard",
            cpu: 32,
            memoryGb: 64,
            default: true,
          },
          { id: "fast", label: "Fast" },
        ],
      },
      {
        id: "invalid-trust",
        providerId: "crabbox",
        trust: undefined,
      },
      {
        id: "legacy",
        providerId: "static-ssh",
        trust: undefined,
      },
      {
        id: "zeta",
        providerId: "static-ssh",
        trust: "disposable",
      },
    ]);
  });

  it.each([
    { name: "empty", executionModes: [] },
    { name: "unknown", executionModes: ["sandbox"] },
    { name: "duplicate", executionModes: ["remote-exec", "remote-exec"] },
  ])(
    "keeps a present $name mode set closed instead of using its primary-mode fallback",
    ({ executionModes }) => {
      expect(
        readDraftCloudProfiles([
          {
            id: "aws",
            providerId: "crabbox",
            executionMode: "remote-exec",
            executionModes,
          },
        ]),
      ).toEqual([
        {
          id: "aws",
          providerId: "crabbox",
          trust: undefined,
          executionModes: [],
        },
      ]);
    },
  );
});

describe("readDraftEnvironments", () => {
  const available = { id: "node:runner", type: "node", status: "available" };
  const hostIssue = {
    code: "worker-host-unavailable",
    message: "state directory /srv/node is group-writable; run chmod go-w /srv/node",
  };
  const updateIssue = {
    code: "update-required",
    action: "update-and-reconnect",
    updateCommand: "openclaw update",
    headlessReconnectCommand: "openclaw node restart",
  };
  const requiredNodeCommand = {
    command: "codex.exec-server.stdio.v1",
    state: "undeclared",
    message: "Enable the codex plugin on this node with openclaw plugins enable codex.",
  };

  it.each([
    {
      name: "actionable worker-host issues",
      input: [
        {
          id: "node:unavailable",
          type: "node",
          status: "unavailable",
          sessionHost: false,
          issues: [
            hostIssue,
            { ...hostIssue, message: " " },
            { ...hostIssue, message: 42 },
            { ...hostIssue, message: "x".repeat(1_025) },
          ],
        },
      ],
      expected: [
        {
          id: "node:unavailable",
          type: "node",
          status: "unavailable",
          sessionHost: false,
          issues: [hostIssue],
        },
      ],
    },
    {
      name: "exact update-required issue contract",
      input: [
        {
          ...available,
          issues: [updateIssue, { ...updateIssue, headlessReconnectCommand: "legacy restart" }],
        },
      ],
      expected: [{ ...available, issues: [updateIssue] }],
    },
    {
      name: "normalized commands and closed required-command state",
      input: [
        {
          ...available,
          capabilities: ["codex.exec-server.stdio.v1", "camera.snap"],
          invocableCommands: [" z.command ", "camera.snap", "camera.snap", "x".repeat(129), ""],
          requiredNodeCommand: { command: " codex.exec-server.stdio.v1 ", state: "unauthorized" },
        },
        {
          ...available,
          id: "node:invalid-state",
          requiredNodeCommand: { command: "runtime.exec", state: "unknown" },
        },
      ],
      expected: [
        { ...available, id: "node:invalid-state" },
        {
          ...available,
          capabilities: ["codex.exec-server.stdio.v1", "camera.snap"],
          invocableCommands: ["camera.snap", "z.command"],
          requiredNodeCommand: { command: "codex.exec-server.stdio.v1", state: "unauthorized" },
        },
      ],
    },
    {
      name: "Gateway remediation for a runtime-required command",
      input: [{ ...available, requiredNodeCommand }],
      expected: [{ ...available, requiredNodeCommand }],
    },
    {
      name: "closed environment types and statuses",
      input: [
        { id: "gateway", type: "local", label: "Gateway", status: "available" },
        { id: "node:macbook", type: "node", status: "unavailable" },
        { id: "worker:aws", type: "worker", status: "starting" },
        { id: "future", type: "future", status: "available" },
        { id: "", type: "node", status: "available" },
        { id: "missing-type", status: "available" },
        { id: "missing-status", type: "node" },
        { id: "unknown-status", type: "node", status: "online" },
      ],
      expected: [
        { id: "gateway", type: "local", label: "Gateway", status: "available" },
        { id: "node:macbook", type: "node", status: "unavailable" },
        { id: "worker:aws", type: "worker", status: "starting" },
      ],
    },
    {
      name: "valid facts and malformed optional fields",
      input: [
        {
          id: "node:macbook",
          type: "node",
          label: " Build Mac ",
          status: "available",
          platform: " darwin ",
          sessionHost: false,
          workerSlots: { total: 4, available: 2 },
          lastConnectedAtMs: 1_000.9,
          lastDisconnectedAtMs: 2_000,
          lastSeenAtMs: 1_500,
          lastSeenReason: " silent_push ",
          trust: "persistent",
          capabilities: [" camera.snap ", 42, "custom.unknown", "system.run", null],
        },
        {
          id: "node:malformed",
          type: "node",
          status: "error",
          platform: { name: "linux" },
          sessionHost: "yes",
          trust: "temporary",
          capabilities: "camera",
        },
      ],
      expected: [
        {
          id: "node:macbook",
          type: "node",
          label: "Build Mac",
          status: "available",
          platform: "darwin",
          sessionHost: false,
          workerSlots: { total: 4, available: 2 },
          lastConnectedAtMs: 1_000,
          lastDisconnectedAtMs: 2_000,
          lastSeenAtMs: 1_500,
          lastSeenReason: "silent_push",
          trust: "persistent",
          capabilities: ["camera.snap", "custom.unknown", "system.run"],
        },
        { id: "node:malformed", type: "node", status: "error" },
      ],
    },
    ...[
      { total: 2.5, available: 1 },
      { total: 0, available: 0 },
      { total: 1_025, available: 1 },
      { total: 2, available: 3 },
      { total: 2, available: 1, queued: 1 },
    ].map((workerSlots) => ({
      name: `invalid worker slots ${JSON.stringify(workerSlots)}`,
      input: [{ ...available, label: "Runner", sessionHost: true, workerSlots }],
      expected: [{ ...available, label: "Runner", sessionHost: true }],
    })),
  ])("retains only $name", ({ input, expected }) => {
    expect(readDraftEnvironments(input)).toEqual(expected);
  });
});
