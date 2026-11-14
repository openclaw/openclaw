import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateLifecyclePlanResult } from "../../packages/gateway-protocol/src/schema/templates.js";
import { listDirectoryTreeStrict } from "../infra/directory-walk.js";
import { defaultRuntime } from "../runtime.js";
import type { GatewayTemplateAddApplyResult } from "../templates/gateway-add-apply.js";
import { useLocalStateOwnerFixture } from "./local-state-owner.fixture.test-support.js";
import * as prompt from "./prompt.js";
import { runTemplatesAddCommand } from "./templates-cli.runtime.js";

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const entry of (await listDirectoryTreeStrict(root)).map((walkEntry) => walkEntry.dirent)) {
    const filename = path.join(entry.parentPath, entry.name);
    snapshot[path.relative(root, filename)] = entry.isDirectory()
      ? "directory"
      : (await fs.readFile(filename)).toString("base64");
  }
  return snapshot;
}

async function withInteractiveTerminal(run: () => Promise<void>): Promise<void> {
  const streams = [process.stdin, process.stdout].map((stream) => ({
    stream,
    descriptor: Object.getOwnPropertyDescriptor(stream, "isTTY"),
  }));
  try {
    for (const { stream } of streams) {
      Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
    }
    await run();
  } finally {
    for (const { stream, descriptor } of streams) {
      if (descriptor) {
        Object.defineProperty(stream, "isTTY", descriptor);
      } else {
        Reflect.deleteProperty(stream, "isTTY");
      }
    }
  }
}

describe("Template Add CLI state ownership", () => {
  const fixture = useLocalStateOwnerFixture();
  const output: unknown[] = [];
  afterEach(() => vi.restoreAllMocks());
  let root: string;
  let source: string;
  let plan: TemplateLifecyclePlanResult;
  let applied: Record<string, unknown>[];
  let entries: Array<{ packageName: string; ownerHandle?: string; latestVersion: string }>;
  let result: GatewayTemplateAddApplyResult;

  beforeEach(async () => {
    root = path.dirname(process.env.OPENCLAW_STATE_DIR!);
    source = path.join(root, "CLAW.md");
    output.length = 0;
    applied = [];
    entries = [
      { packageName: "@acme/other", latestVersion: "9.9.9" },
      { packageName: "@acme/demo", latestVersion: "1.2.3" },
    ];
    plan = {
      schemaVersion: "openclaw.templatesGatewayPlan.v1",
      operation: "add",
      planIntegrity: "reviewed-plan",
      target: { agentId: "demo" },
      actions: [],
      capabilities: [],
      pluginReviews: [],
      skillReviews: [],
      blockers: [],
      riskAcknowledgementRequired: false,
    };
    result = { agentId: "demo", status: "complete", readiness: { ready: true, requirements: [] } };
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    fixture.handlers = {
      "templates.catalog.search": async ({ respond }) => respond(true, { entries }),
      "templates.add.plan": async ({ params, respond }) => {
        expect(params).toEqual({ source: { packageName: "@acme/demo", version: "1.2.3" } });
        respond(true, plan);
      },
      "templates.add.apply": async ({ params, respond }) => {
        applied.push(params);
        respond(true, result);
      },
    };
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) => output.push(value));
    await fs.writeFile(
      source,
      `---\n${JSON.stringify({ schemaVersion: 1, agent: { id: "demo" } })}\n---\n`,
    );
  });

  it("permits read-only preview but refuses Add while another process owns Gateway state", async () => {
    await fs.writeFile(
      process.env.OPENCLAW_CONFIG_PATH!,
      JSON.stringify({ gateway: { controlUi: { experimental: { templates: true } } } }),
    );
    await fixture.startOwner();
    const before = await snapshotTree(root);
    await expect(runTemplatesAddCommand(source, { json: true })).rejects.toThrow(
      /exclusive offline state ownership.*stop the Gateway/s,
    );
    expect(output).toEqual([]);
    expect(await snapshotTree(root)).toEqual(before);

    await runTemplatesAddCommand(source, { dryRun: true, json: true });
    expect(output).toEqual([
      expect.objectContaining({
        agent: expect.objectContaining({ finalId: "demo" }),
        blockers: [],
      }),
    ]);
    expect(await snapshotTree(root)).toEqual(before);
    expect(fixture.transport.request).not.toHaveBeenCalled();
  });

  it("adds a ClawHub Template through the running owner without local mutation", async () => {
    plan.target.agentId = "demo-2";
    result.agentId = "demo-2";
    await fixture.startOwner();
    const before = await snapshotTree(root);
    await runTemplatesAddCommand("@acme/demo", { json: true });
    expect(output).toEqual([
      { agentId: "demo-2", status: "complete", readiness: { ready: true, requirements: [] } },
    ]);
    expect(applied).toEqual([
      {
        source: { packageName: "@acme/demo", version: "1.2.3" },
        agentId: "demo-2",
        planIntegrity: "reviewed-plan",
        acknowledgeCapabilities: [],
        acknowledgeSkillWarnings: [],
      },
    ]);
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("adds an unscoped ClawHub Template by its publisher-qualified reference", async () => {
    entries = [
      { packageName: "demo", ownerHandle: "mallory", latestVersion: "9.9.9" },
      { packageName: "@acme/demo", latestVersion: "1.2.3" },
    ];
    await fixture.startOwner();
    // The exact scoped name wins over another publisher's unscoped package.
    await runTemplatesAddCommand("@acme/demo", { json: true });

    entries = [{ packageName: "demo", ownerHandle: "acme", latestVersion: "1.2.3" }];
    fixture.handlers["templates.add.plan"] = async ({ params, respond }) => {
      expect(params).toEqual({ source: { packageName: "demo", version: "1.2.3" } });
      respond(true, plan);
    };
    await runTemplatesAddCommand("@acme/demo", { json: true });
    expect(applied).toHaveLength(2);
  });

  it("rejects an online workspace override without touching state or dispatching", async () => {
    await fixture.startOwner();
    const before = await snapshotTree(root);
    await expect(
      runTemplatesAddCommand("@acme/demo", { workspace: path.join(root, "target"), json: true }),
    ).rejects.toThrow("Omit --workspace");
    expect(await snapshotTree(root)).toEqual(before);
    expect(fixture.transport.request).not.toHaveBeenCalled();
  });

  it.each(["missing", "ambiguous", "unpublished"])(
    "refuses a %s catalog identity before Add",
    async (kind) => {
      entries =
        kind === "missing"
          ? [{ packageName: "@acme/other", latestVersion: "1.2.3" }]
          : kind === "ambiguous"
            ? [
                { packageName: "@acme/demo", latestVersion: "1.2.3" },
                { packageName: "@acme/demo", latestVersion: "1.2.4" },
              ]
            : [{ packageName: "@acme/demo", latestVersion: "latest" }];
      await fixture.startOwner();
      const before = await snapshotTree(root);
      await expect(runTemplatesAddCommand("@acme/demo", { json: true })).rejects.toThrow(
        "one exact published Template version",
      );
      expect(applied).toEqual([]);
      expect(await snapshotTree(root)).toEqual(before);
    },
  );

  it.each(["missing-digest", "blocked", "labs-off", "plan-drift"])(
    "does not fall back locally for %s",
    async (kind) => {
      if (kind === "missing-digest") {
        plan.planIntegrity = "";
      }
      if (kind === "blocked") {
        plan.blockers = [
          { code: "fixture_blocked", path: "$", message: "Requirements unavailable." },
        ];
      }
      const method = kind === "labs-off" ? "templates.add.plan" : "templates.add.apply";
      if (kind === "labs-off" || kind === "plan-drift") {
        fixture.handlers[method] = async ({ params, respond }) => {
          if (method === "templates.add.apply") {
            applied.push(params);
          }
          respond(false, undefined, {
            code: "FORBIDDEN",
            message:
              kind === "labs-off"
                ? "Templates Labs is disabled"
                : "The Template changed since review",
          });
        };
      }
      await fixture.startOwner();
      const before = await snapshotTree(root);
      if (kind === "blocked") {
        await runTemplatesAddCommand("@acme/demo", { json: true });
        expect(output).toEqual([
          expect.objectContaining({
            blockers: [expect.objectContaining({ code: "fixture_blocked" })],
          }),
        ]);
        expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
      } else {
        await expect(runTemplatesAddCommand("@acme/demo", { json: true })).rejects.toThrow(
          kind === "missing-digest"
            ? "bound Template Add review"
            : kind === "labs-off"
              ? "Labs is disabled"
              : "changed since review",
        );
      }
      expect(applied).toHaveLength(kind === "plan-drift" ? 1 : 0);
      expect(await snapshotTree(root)).toEqual(before);
    },
  );

  it.each(["partial", "partial-human", "lost-reply"])(
    "retains the owner's %s outcome without replay or local cleanup",
    async (kind) => {
      result = kind.startsWith("partial")
        ? {
            agentId: "demo",
            status: "partial",
            readiness: { ready: false, requirements: [] },
            error: { code: "native_partial", message: "Inspect retained Gateway state." },
          }
        : result;
      const apply = fixture.handlers["templates.add.apply"]!;
      fixture.handlers["templates.add.apply"] = async (request) => {
        await apply(request);
        fixture.transport.failReply = kind === "lost-reply";
      };
      await fixture.startOwner();
      const before = await snapshotTree(root);
      if (kind === "lost-reply") {
        await expect(runTemplatesAddCommand("@acme/demo", { json: true })).rejects.toThrow(
          "outcome may be partial",
        );
        expect(output).toEqual([]);
      } else {
        await runTemplatesAddCommand("@acme/demo", { json: kind !== "partial-human" });
        if (kind === "partial-human") {
          expect(defaultRuntime.log).toHaveBeenCalledWith(
            expect.stringContaining("Template Add partial for agent demo"),
          );
          expect(defaultRuntime.error).toHaveBeenCalledWith("Inspect retained Gateway state.");
        } else {
          expect(output).toEqual([result]);
        }
        expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
      }
      expect(applied).toHaveLength(1);
      expect(await snapshotTree(root)).toEqual(before);
    },
  );

  it.each(["none", "capabilities-only", "risk-only", "both", "declined-sibling"])(
    "requires separate exact plugin and skill trust consent: %s",
    async (kind) => {
      const grants = {
        hooks: {
          allowPromptInjection: { effective: false },
          allowConversationAccess: { effective: false },
        },
      };
      const siblingGrants = {
        hooks: {
          allowPromptInjection: { effective: true },
          allowConversationAccess: { effective: false },
        },
      };
      plan.pluginReviews = [
        {
          source: "bundled",
          path: "plugins/proof",
          digest: "sha256:" + "a".repeat(64),
          actionId: "plugin:proof",
          pluginId: "proof",
          ownerAction: "install",
          declaredCapabilities: {
            channels: [],
            providers: [],
            tools: ["proof"],
            contracts: [],
            hooks: [],
            mcpServers: [],
            cliCommands: [],
            cliBackends: [],
            skills: [],
            dangerousConfigFlags: [],
          },
          capabilityGrants: grants,
          capabilityGrantsByPluginId: { proof: grants, "proof-sibling": siblingGrants },
          reviewToken: "exact-plugin-review",
          riskWarning: "Review plugin trust.",
        },
      ];
      plan.skillReviews = [
        {
          source: "clawhub",
          ref: "@acme/proof",
          version: "1.0.0",
          integrity: "sha256:" + "b".repeat(64),
          actionId: "skill:proof",
          reviewToken: "exact-skill-review",
          riskWarning: "Review skill trust.",
        },
        {
          source: "bundled",
          path: "skills/proof",
          name: "proof",
          digest: "sha256:" + "c".repeat(64),
          actionId: "skill:bundled:skills/proof",
          reviewToken: "bundled-skill-review",
          riskWarning: "Review bundled skill trust.",
        },
      ];
      plan.trustWarning = "Review registry trust.";
      plan.riskAcknowledgementRequired = true;
      await fixture.startOwner();
      const before = await snapshotTree(root);
      const run = () =>
        runTemplatesAddCommand("@acme/demo", {
          json: kind !== "declined-sibling",
          acceptCapabilities: kind === "both" || kind === "capabilities-only",
          acknowledgeClawhubRisk:
            kind === "both" || kind === "risk-only" || kind === "declined-sibling",
        });
      if (kind === "declined-sibling") {
        const approval = vi
          .spyOn(prompt, "promptYesNo")
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(false);
        await withInteractiveTerminal(run);
        expect(approval).toHaveBeenCalledTimes(2);
        expect(approval).toHaveBeenNthCalledWith(2, expect.stringContaining("proof-sibling"));
        expect(defaultRuntime.log).toHaveBeenCalledWith(
          expect.stringContaining("Prompt injection: allowed"),
        );
        expect(applied).toEqual([]);
        expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
      } else {
        await run();
      }
      if (kind === "both") {
        expect(applied).toEqual([
          {
            source: { packageName: "@acme/demo", version: "1.2.3" },
            agentId: "demo",
            planIntegrity: "reviewed-plan",
            acknowledgeClawHubRisk: true,
            acknowledgeCapabilities: [
              {
                actionId: "plugin:proof",
                pluginId: "proof",
                reviewToken: "exact-plugin-review",
                capabilityGrants: grants,
                capabilityGrantsByPluginId: { proof: grants, "proof-sibling": siblingGrants },
                acknowledgeRiskWarning: true,
              },
            ],
            acknowledgeSkillWarnings: [
              {
                actionId: "skill:proof",
                source: "clawhub",
                ref: "@acme/proof",
                reviewToken: "exact-skill-review",
                acknowledgeRiskWarning: true,
              },
              {
                actionId: "skill:bundled:skills/proof",
                source: "bundled",
                path: "skills/proof",
                digest: "sha256:" + "c".repeat(64),
                reviewToken: "bundled-skill-review",
                acknowledgeRiskWarning: true,
              },
            ],
          },
        ]);
        expect(output).toEqual([result]);
      } else if (kind !== "declined-sibling") {
        expect(applied).toEqual([]);
        expect(output).toEqual([
          expect.objectContaining({
            status: "failed",
            error: expect.objectContaining({
              code:
                kind === "risk-only"
                  ? "plugin_capability_consent_required"
                  : "clawhub_risk_acknowledgement_required",
            }),
          }),
        ]);
        expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
      }
      expect(await snapshotTree(root)).toEqual(before);
    },
  );
});
