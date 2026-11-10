import "../test-utils/prepare-compiled-subprocesses.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assert, expect, it } from "vitest";
import { applyTemplateAddPlanStateless } from "../templates/add-stateless.js";
import { buildGatewayTemplateAddPlan } from "../templates/gateway-add-plan.js";
import { bindTemplatePluginInstallConsent } from "../templates/gateway-plugin-consent.js";
import {
  installTemplatePackages,
  rollbackStatelessTemplatePackages,
} from "../templates/packages.js";
import { projectTemplatePluginCapabilityReviews } from "../templates/plugin-capability-review.js";
import { buildTemplateProject, extractBuiltTemplateArtifact } from "../templates/project-build.js";
import { readTemplateManifestFile } from "../templates/reader.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { loadInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records.js";

const pluginId = "template-directory-probe";
const pluginCode = 'export default { id: "template-directory-probe", register() {} };\n';

it("builds a plugin directory and installs the reviewed artifact through native plugin management", async () => {
  await withOpenClawTestState({ label: "template-bundled-plugin" }, async (fixture) => {
    const project = fixture.statePath("project");
    const plugin = path.join(project, "plugins", "probe");
    await mkdir(plugin, { recursive: true });
    await writeFile(
      path.join(project, "package.json"),
      JSON.stringify({
        name: "@fixture/bundled-plugin-template",
        version: "1.0.0",
        openclaw: { template: "CLAW.md" },
      }),
    );
    await writeFile(
      path.join(project, "CLAW.md"),
      `---\n${JSON.stringify({
        schemaVersion: 1,
        agent: { id: "bundle-consumer" },
        plugins: [{ path: "plugins/probe" }],
      })}\n---\nUse the bundled probe.\n`,
    );
    await writeFile(
      path.join(plugin, "package.json"),
      JSON.stringify({
        name: "@fixture/template-directory-probe",
        version: "1.0.0",
        type: "module",
        openclaw: { extensions: ["./index.js"] },
      }),
    );
    await writeFile(
      path.join(plugin, "openclaw.plugin.json"),
      JSON.stringify({
        id: pluginId,
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
    );
    await writeFile(path.join(plugin, "index.js"), pluginCode);
    const built = await buildTemplateProject(project, fixture.statePath("template.tgz"));
    await writeFile(path.join(plugin, "index.js"), "Changed after building.\n");
    await using extracted = await extractBuiltTemplateArtifact(built.artifact);
    const source = await readTemplateManifestFile(extracted.packageRoot);
    assert(source.ok, JSON.stringify(source.diagnostics));
    const policyPath = fixture.statePath("policy.cjs");
    await writeFile(
      policyPath,
      `#!${process.execPath}
let input = "";
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  const verified = request.source?.authority === "third-party" && request.source.mutable === false;
  process.stdout.write(JSON.stringify({ protocolVersion: 1, decision: verified ? "warn" : "block", reason: "Review bundled third-party code", findings: [{ ruleId: "template-review", severity: "warn", message: "Review package finding" }] }));
});
`,
      { mode: 0o700 },
    );
    const config = {
      agents: { entries: { main: {} } },
      plugins: { allow: [pluginId] },
      security: {
        installPolicy: {
          enabled: true,
          exec: { source: "exec" as const, command: policyPath, trustedDirs: [fixture.stateDir] },
        },
      },
    };
    await fixture.writeConfig(config);
    const plan = await buildGatewayTemplateAddPlan(source, { config, sourceMcpServers: {} });
    expect(plan.blockers).toEqual([]);
    const incomplete = await buildGatewayTemplateAddPlan(source, {
      config,
      sourceMcpServers: {},
      packagePreflight: async () => ({
        ok: true,
        action: "install",
        name: pluginId,
        installId: pluginId,
        snapshot: source.snapshot.bundledSources![0]!.snapshot,
      }),
    });
    expect(incomplete.blockers).toContainEqual(
      expect.objectContaining({ code: "plugin_capability_provenance_incomplete" }),
    );
    const reviews = projectTemplatePluginCapabilityReviews(plan);
    expect(reviews[0]).toMatchObject({ source: "bundled", path: "plugins/probe", pluginId });
    expect(reviews[0]).not.toHaveProperty("ref");
    expect(reviews[0]).not.toHaveProperty("version");
    expect(reviews[0]?.riskWarning).toContain("Review package finding");
    const pluginConsent = bindTemplatePluginInstallConsent(
      reviews,
      reviews.map((review) => ({
        actionId: review.actionId,
        pluginId: review.pluginId,
        reviewToken: review.reviewToken,
        capabilityGrants: review.capabilityGrants,
        capabilityGrantsByPluginId: review.capabilityGrantsByPluginId,
        acknowledgeRiskWarning: review.riskWarning ? (true as const) : undefined,
      })),
      () => {},
    );
    await expect(installTemplatePackages(plan, { config })).rejects.toThrow(
      /explicit Template capability acknowledgment/,
    );
    expect((await loadInstalledPluginIndexInstallRecords())[pluginId]).toBeUndefined();
    const stagedPlugin = path.join(extracted.packageRoot, "plugins/probe/index.js");
    await writeFile(stagedPlugin, "Changed after review.\n");
    await expect(installTemplatePackages(plan, { config, pluginConsent })).rejects.toThrow(
      /changed after planning/,
    );
    expect((await loadInstalledPluginIndexInstallRecords())[pluginId]).toBeUndefined();
    await writeFile(stagedPlugin, pluginCode);
    const introduced = await installTemplatePackages(plan, { config, pluginConsent });
    expect(introduced[0]).toMatchObject({ source: "bundled", origin: "template-introduced" });
    expect(await rollbackStatelessTemplatePackages(introduced)).toEqual([]);
    expect((await loadInstalledPluginIndexInstallRecords())[pluginId]).toBeUndefined();
    await fixture.writeConfig(config);
    const result = await applyTemplateAddPlanStateless(plan, {
      config,
      consentPlanIntegrity: plan.planIntegrity,
      pluginConsent,
    });
    expect(result.status, result.error?.message).toBe("complete");
    const record = (await loadInstalledPluginIndexInstallRecords())[pluginId];
    expect(record).toMatchObject({ source: "archive", version: "1.0.0" });
    expect(record).not.toHaveProperty("clawhubPackage");
    expect(await readFile(path.join(record!.installPath!, "index.js"), "utf8")).toBe(pluginCode);
    expect(record?.acceptedSurfaceIntegrity).toBe(record?.integrity);
    expect(result.packages[0]).toMatchObject({
      source: "bundled",
      path: "plugins/probe",
      origin: "template-introduced",
    });

    const reused = await buildGatewayTemplateAddPlan(source, {
      config,
      sourceMcpServers: {},
      agentId: "second-consumer",
    });
    expect(reused.blockers).toEqual([]);
    expect(projectTemplatePluginCapabilityReviews(reused)[0]?.ownerAction).toBe("reuse");
    const receipts = await installTemplatePackages(reused, { config });
    expect(receipts[0]).toMatchObject({ origin: "pre-existing", independentOwner: true });
    expect(await rollbackStatelessTemplatePackages(receipts)).toEqual([]);
    expect((await loadInstalledPluginIndexInstallRecords())[pluginId]).toEqual(record);

    await writeFile(
      path.join(record!.installPath!, "index.js"),
      "Preserve the installed owner's change.\n",
    );
    const conflict = await buildGatewayTemplateAddPlan(source, {
      config,
      sourceMcpServers: {},
      agentId: "third-consumer",
    });
    expect(conflict.blockers).toContainEqual(
      expect.objectContaining({ code: "bundled_plugin_conflict" }),
    );
    expect(await readFile(path.join(record!.installPath!, "index.js"), "utf8")).toBe(
      "Preserve the installed owner's change.\n",
    );
    await rm(path.join(extracted.packageRoot, "plugins/probe/package.json"));
    await rm(path.join(extracted.packageRoot, "plugins/probe/openclaw.plugin.json"));
    const bundleManifest = path.join(extracted.packageRoot, "plugins/probe/.codex-plugin");
    await mkdir(bundleManifest);
    await writeFile(path.join(bundleManifest, "plugin.json"), "{}");
    const unnamedBundle = await readTemplateManifestFile(extracted.packageRoot);
    expect(unnamedBundle.ok).toBe(false);
    expect(unnamedBundle.diagnostics).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("must declare a nonempty manifest name"),
      }),
    );
  });
});
