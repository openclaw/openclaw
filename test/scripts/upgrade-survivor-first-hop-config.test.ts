import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const helper = resolve("scripts/e2e/lib/upgrade-survivor/first-hop-config-preservation.mjs");
const laneScript = resolve("scripts/e2e/lib/upgrade-survivor/update-first-hop-compat.sh");
const targetVersion = "2026.9.5";
const fixtureEnv = () => ({
  ...process.env,
  GIT_COMMIT: undefined,
  GIT_SHA: undefined,
  UPGRADE_SURVIVOR_PREFIX: undefined,
  UPGRADE_SURVIVOR_LITERAL: undefined,
});

function makeFixture(seed = true) {
  const root = realpathSync(tempDirs.make("survivor-first-hop-config-"));
  const artifacts = join(root, "artifacts");
  mkdirSync(artifacts);
  const config = join(root, "openclaw.json");
  const initial = {
    gateway: {
      mode: "local",
      port: 18792,
      reload: { mode: "off" },
      auth: { mode: "token", token: "synthetic-token" },
    },
    meta: { lastTouchedVersion: "2026.9.2", migrations: { modelPolicyAllowlist: true } },
    agents: { defaults: { model: { primary: "openai/test-model" } } },
    models: { mode: "merge", providers: { openai: { baseUrl: "http://127.0.0.1:44212/v1" } } },
    env: { vars: { EXISTING_FIXTURE_VAR: "keep-this" } },
  };
  writeFileSync(config, `${JSON.stringify(initial, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(`${config}.bak`, '{"gateway":{"mode":"local","port":18791}}\n', { mode: 0o600 });
  writeFileSync(`${config}.bak.1`, '{"gateway":{"mode":"local","port":18790}}\n', { mode: 0o600 });
  const fixture = { root, artifacts, config, initial };
  if (seed) {
    expectSuccess(run(fixture, "seed", targetVersion));
  }
  return fixture;
}

type Fixture = ReturnType<typeof makeFixture>;

function run(fixture: { artifacts: string; config: string }, command: string, extra?: string) {
  return spawnSync(
    process.execPath,
    [helper, command, fixture.config, fixture.artifacts, ...(extra ? [extra] : [])],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: fixtureEnv(),
    },
  );
}

function expectSuccess(result: ReturnType<typeof run>) {
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status, result.stderr).toBe(0);
}

function expectFailure(result: ReturnType<typeof run>, message: string) {
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(message);
  expect(result.stdout).not.toContain("passed");
}

function prepareHop(fixture: Fixture) {
  copyFileSync(fixture.config, `${fixture.config}.pre-update`);
}

function doctorOutput(fixture: Fixture, output = "Doctor complete.\n", phase = "fresh") {
  writeFileSync(join(fixture.artifacts, `positive-${phase}-doctor.stdout`), output);
  writeFileSync(join(fixture.artifacts, `positive-${phase}-doctor.stderr`), "");
}

function rewriteRoot(
  fixture: Fixture,
  version: string,
  activateOpenai = false,
  persistRoster = false,
) {
  const config = JSON.parse(readFileSync(fixture.config, "utf8"));
  config.meta.lastTouchedVersion = version;
  if (persistRoster && config.agents?.entries === undefined) {
    config.agents = { ...config.agents, entries: { main: {} } };
  }
  if (activateOpenai) {
    config.plugins = {
      ...config.plugins,
      entries: {
        ...config.plugins?.entries,
        openai: { ...config.plugins?.entries?.openai, enabled: true },
      },
    };
  }
  for (let index = 4; index >= 1; index -= 1) {
    const from = `${fixture.config}.bak${index === 1 ? "" : `.${index - 1}`}`;
    if (existsSync(from)) {
      renameSync(from, `${fixture.config}.bak.${index}`);
    }
  }
  copyFileSync(fixture.config, `${fixture.config}.bak`);
  writeFileSync(`${fixture.config}.next`, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${fixture.config}.next`, fixture.config);
}

function completeRepair(fixture: Fixture) {
  rewriteRoot(fixture, targetVersion, true, true);
  doctorOutput(fixture, "Doctor complete.\n", "repair");
  expectSuccess(run(fixture, "assert-repair"));
}

describe("packaged first-hop config preservation assertions", () => {
  it("adds admitted references without replacing the positive lane config, then accepts a converged Doctor", () => {
    const fixture = makeFixture();
    const seeded = JSON.parse(readFileSync(fixture.config, "utf8"));
    expect(seeded).toStrictEqual({
      ...fixture.initial,
      env: {
        vars: {
          ...fixture.initial.env.vars,
          UPGRADE_SURVIVOR_PREFIX: "first-hop-prefix",
          UPGRADE_SURVIVOR_LITERAL: "must-not-be-activated",
        },
      },
      messages: { $include: "./first-hop-messages.json" },
    });
    expect(
      JSON.parse(readFileSync(join(fixture.root, "first-hop-messages.json"), "utf8")),
    ).toStrictEqual({
      $include: "./first-hop-messages-leaf.json",
    });
    expect(
      JSON.parse(readFileSync(join(fixture.root, "first-hop-messages-leaf.json"), "utf8")),
    ).toStrictEqual({
      responsePrefix: "${UPGRADE_SURVIVOR_PREFIX}",
      usageTemplate: "$${UPGRADE_SURVIVOR_LITERAL}",
    });
    prepareHop(fixture);
    expectSuccess(run(fixture, "assert-hop"));
    expect(existsSync(join(fixture.artifacts, "positive-config-converged.json"))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(fixture.artifacts, "positive-config-after-hop.json"), "utf8"))
        .kind,
    ).toBe("after-hop-observation");
    completeRepair(fixture);
    expect(
      JSON.parse(readFileSync(join(fixture.artifacts, "positive-config-converged.json"), "utf8"))
        .activationPhase,
    ).toBe("first-repair");
    expect(
      JSON.parse(readFileSync(join(fixture.artifacts, "positive-config-converged.json"), "utf8"))
        .rosterPhase,
    ).toBe("first-repair");
    doctorOutput(fixture);
    expectSuccess(run(fixture, "assert-doctor"));
  });

  it("allows version stamping and ordered backup renames while keeping the original root outside the ring", () => {
    const fixture = makeFixture();
    const original = readFileSync(fixture.config, "utf8");
    prepareHop(fixture);
    rewriteRoot(fixture, targetVersion);
    rewriteRoot(fixture, targetVersion);
    expectSuccess(run(fixture, "assert-hop"));
    expect(readFileSync(`${fixture.config}.pre-update`, "utf8")).toBe(original);
    expect(readFileSync(`${fixture.config}.bak.first-hop-manual`, "utf8")).toBe(original);
  });

  it("allows only the selected OpenAI plugin activation", () => {
    const fixture = makeFixture();
    prepareHop(fixture);
    const config = JSON.parse(readFileSync(fixture.config, "utf8"));
    config.plugins = { entries: { openai: { enabled: true } } };
    writeFileSync(fixture.config, JSON.stringify(config));
    expectSuccess(run(fixture, "assert-hop"));
    rewriteRoot(fixture, targetVersion, false, true);
    doctorOutput(fixture, "Doctor complete.\n", "repair");
    expectSuccess(run(fixture, "assert-repair"));
    expect(
      JSON.parse(readFileSync(join(fixture.artifacts, "positive-config-converged.json"), "utf8"))
        .activationPhase,
    ).toBe("first-hop");
  });

  it("preserves existing OpenAI entry fields and unrelated plugin policy during activation", () => {
    const fixture = makeFixture(false);
    const config = JSON.parse(readFileSync(fixture.config, "utf8"));
    config.plugins = {
      enabled: true,
      allow: ["openai", "other"],
      deny: ["denied"],
      entries: { openai: { config: { marker: "keep" } }, other: { enabled: false } },
    };
    writeFileSync(fixture.config, JSON.stringify(config));
    expectSuccess(run(fixture, "seed", targetVersion));
    prepareHop(fixture);
    expectSuccess(run(fixture, "assert-hop"));
    completeRepair(fixture);
    expect(JSON.parse(readFileSync(fixture.config, "utf8")).plugins).toStrictEqual({
      ...config.plugins,
      entries: { ...config.plugins.entries, openai: { config: { marker: "keep" }, enabled: true } },
    });
  });

  it.each([
    "disabled",
    "unselected model",
    "entry content",
    "unrelated plugin",
    "global disable",
    "denied",
  ])("does not exempt %s from strict plugin preservation", (change) => {
    const fixture = makeFixture(false);
    const config = JSON.parse(readFileSync(fixture.config, "utf8"));
    config.plugins = { entries: { openai: { config: { marker: "keep" } } } };
    if (change === "disabled") {
      config.plugins.entries.openai.enabled = false;
    } else if (change === "unselected model") {
      config.agents.defaults.model.primary = "other/test-model";
    } else if (change === "global disable") {
      config.plugins.enabled = false;
    } else if (change === "denied") {
      config.plugins.deny = ["openai"];
    }
    writeFileSync(fixture.config, JSON.stringify(config));
    expectSuccess(run(fixture, "seed", targetVersion));
    prepareHop(fixture);
    const changed = JSON.parse(readFileSync(fixture.config, "utf8"));
    changed.plugins.entries.openai.enabled = true;
    if (change === "entry content") {
      changed.plugins.entries.openai.config.marker = "changed";
    } else if (change === "unrelated plugin") {
      changed.plugins.entries.other = { enabled: true };
    }
    writeFileSync(fixture.config, JSON.stringify(changed));
    expectFailure(run(fixture, "assert-hop"), "root config changed outside permitted metadata");
  });

  it("does not invent an activation requirement in lanes without the mock OpenAI model", () => {
    const fixture = makeFixture(false);
    const config = JSON.parse(readFileSync(fixture.config, "utf8"));
    delete config.agents.defaults.model;
    delete config.models;
    writeFileSync(fixture.config, JSON.stringify(config));
    expectSuccess(run(fixture, "seed", targetVersion));
    prepareHop(fixture);
    expectSuccess(run(fixture, "assert-hop"));
    rewriteRoot(fixture, targetVersion, false, true);
    doctorOutput(fixture, "Doctor complete.\n", "repair");
    expectSuccess(run(fixture, "assert-repair"));
    expect(
      JSON.parse(readFileSync(join(fixture.artifacts, "positive-config-converged.json"), "utf8"))
        .activationPhase,
    ).toBe("not-required");
    doctorOutput(fixture);
    expectSuccess(run(fixture, "assert-doctor"));
  });

  it("rejects a completed first repair without the required durable activation", () => {
    const fixture = makeFixture();
    prepareHop(fixture);
    expectSuccess(run(fixture, "assert-hop"));
    doctorOutput(fixture, "Doctor complete.\n", "repair");
    expectFailure(run(fixture, "assert-repair"), "required fixture OpenAI activation missing");
    expect(existsSync(join(fixture.artifacts, "positive-config-converged.json"))).toBe(false);
  });

  it.each(["absent", "defaults-only"])("accepts only the canonical %s roster repair", (kind) => {
    const fixture = makeFixture(false);
    const original = JSON.parse(readFileSync(fixture.config, "utf8"));
    if (kind === "absent") {
      delete original.agents;
    }
    writeFileSync(fixture.config, JSON.stringify(original));
    expectSuccess(run(fixture, "seed", targetVersion));
    prepareHop(fixture);
    const repaired = JSON.parse(readFileSync(fixture.config, "utf8"));
    repaired.agents = { ...repaired.agents, entries: { main: {} } };
    writeFileSync(fixture.config, JSON.stringify(repaired));
    expectSuccess(run(fixture, "assert-hop"));
    if (kind === "absent") {
      doctorOutput(fixture, "Doctor complete.\n", "repair");
      expectSuccess(run(fixture, "assert-repair"));
    } else {
      completeRepair(fixture);
    }
    const converged = JSON.parse(
      readFileSync(join(fixture.artifacts, "positive-config-converged.json"), "utf8"),
    );
    expect(converged.rosterPhase).toBe("first-hop");
    expect(JSON.parse(converged.files["openclaw.json"].raw).agents).toStrictEqual({
      ...original.agents,
      entries: { main: {} },
    });
    if (kind === "absent") {
      expect(converged.activationPhase).toBe("not-required");
    }
  });

  it.each([
    "explicit ownership",
    "workspace",
    "model",
    "default marker",
    "extra agent",
    "changed defaults",
    "authored roster",
    "legacy roster",
    "include-owned roster",
  ])("does not exempt %s from strict roster preservation", (change) => {
    const fixture = makeFixture(false);
    const original = JSON.parse(readFileSync(fixture.config, "utf8"));
    if (change === "explicit ownership") {
      original.agents.ownership = "explicit";
    } else if (change === "authored roster") {
      original.agents.entries = { main: { name: "retained" } };
    } else if (change === "legacy roster") {
      original.agents.list = [{ id: "retained" }];
    } else if (change === "include-owned roster") {
      original.agents = { $include: "./agent-roster.json" };
      writeFileSync(join(fixture.root, "agent-roster.json"), '{"entries":{"main":{}}}');
    }
    writeFileSync(fixture.config, JSON.stringify(original));
    expectSuccess(run(fixture, "seed", targetVersion));
    prepareHop(fixture);
    const changed = JSON.parse(readFileSync(fixture.config, "utf8"));
    changed.agents.entries = { main: {} };
    if (change === "workspace") {
      changed.agents.entries.main.workspace = "/synthetic/workspace";
    } else if (change === "model") {
      changed.agents.entries.main.model = "other/test-model";
    } else if (change === "default marker") {
      changed.agents.entries.main.default = true;
    } else if (change === "extra agent") {
      changed.agents.entries.other = {};
    } else if (change === "changed defaults") {
      changed.agents.defaults.model.primary = "other/test-model";
    } else if (change === "legacy roster") {
      delete changed.agents.list;
    } else if (change === "include-owned roster") {
      delete changed.agents.$include;
    }
    writeFileSync(fixture.config, JSON.stringify(changed));
    expectFailure(run(fixture, "assert-hop"), "root config changed outside permitted metadata");
  });

  it.each([false, true])(
    "checks canonical roster fields in intermediate backups (damage=%s)",
    (damage) => {
      const fixture = makeFixture();
      prepareHop(fixture);
      rewriteRoot(fixture, targetVersion);
      const config = JSON.parse(readFileSync(fixture.config, "utf8"));
      config.agents.entries = { main: {} };
      writeFileSync(fixture.config, JSON.stringify(config));
      rewriteRoot(fixture, targetVersion, true);
      if (damage) {
        const backup = JSON.parse(readFileSync(`${fixture.config}.bak`, "utf8"));
        backup.agents.entries.main.workspace = "/synthetic/unexpected";
        writeFileSync(`${fixture.config}.bak`, JSON.stringify(backup));
        expectFailure(run(fixture, "assert-hop"), "backup ring lost or rewrote recovery history");
      } else {
        expectSuccess(run(fixture, "assert-hop"));
      }
    },
  );

  it.each(["root", "include"])("retains a private observation when %s validation fails", (kind) => {
    const fixture = makeFixture();
    prepareHop(fixture);
    const name = kind === "root" ? "openclaw.json" : "first-hop-messages-leaf.json";
    const file = join(fixture.root, name);
    const config = JSON.parse(readFileSync(file, "utf8"));
    config.unexpected = "synthetic-private-value";
    const raw = JSON.stringify(config);
    writeFileSync(file, raw);
    const result = run(fixture, "assert-hop");
    expectFailure(
      result,
      kind === "root"
        ? "root config changed outside permitted metadata"
        : "file changed: first-hop-messages-leaf.json",
    );
    const observationPath = join(fixture.artifacts, "positive-config-after-hop.json");
    const observation = JSON.parse(readFileSync(observationPath, "utf8"));
    expect(observation.kind).toBe("after-hop-observation");
    expect(observation.files[name].raw).toBe(raw);
    if (process.platform !== "win32") {
      expect(statSync(observationPath).mode & 0o777).toBe(0o600);
    }
    expect(observation).not.toHaveProperty("activationPhase");
    expect(existsSync(join(fixture.artifacts, "positive-config-converged.json"))).toBe(false);
    expect(result.stderr).not.toContain(config.unexpected);
    expect(result.stderr).not.toContain(fixture.root);
  });

  it.each(["root", "include", "backup"])(
    "revalidates unverified %s observations before repair",
    (kind) => {
      const fixture = makeFixture(false);
      const config = JSON.parse(readFileSync(fixture.config, "utf8"));
      config.agents.entries = { main: {} };
      config.plugins = { entries: { openai: { enabled: true } } };
      writeFileSync(fixture.config, JSON.stringify(config));
      expectSuccess(run(fixture, "seed", targetVersion));
      prepareHop(fixture);
      expectSuccess(run(fixture, "assert-hop"));
      const observationPath = join(fixture.artifacts, "positive-config-after-hop.json");
      const observation = JSON.parse(readFileSync(observationPath, "utf8"));
      const name =
        kind === "root"
          ? "openclaw.json"
          : kind === "include"
            ? "first-hop-messages-leaf.json"
            : "openclaw.json.bak";
      if (kind === "root") {
        const observedConfig = JSON.parse(observation.files[name].raw);
        observedConfig.gateway.port = 1;
        observation.files[name].raw = JSON.stringify(observedConfig);
      } else {
        observation.files[name].raw = "{}\n";
        writeFileSync(join(fixture.root, name), observation.files[name].raw);
      }
      writeFileSync(observationPath, JSON.stringify(observation));
      doctorOutput(fixture, "Doctor complete.\n", "repair");
      expectFailure(
        run(fixture, "assert-repair"),
        kind === "root"
          ? "root config changed outside permitted metadata"
          : kind === "include"
            ? "file changed: first-hop-messages-leaf.json"
            : "backup ring lost or rewrote recovery history",
      );
      expect(existsSync(join(fixture.artifacts, "positive-config-converged.json"))).toBe(false);
    },
  );

  it.each([false, true])(
    "never overwrites an observation or hides a primary failure (invalid=%s)",
    (invalid) => {
      const fixture = makeFixture();
      prepareHop(fixture);
      const observationPath = join(fixture.artifacts, "positive-config-after-hop.json");
      writeFileSync(observationPath, "retained evidence");
      if (invalid) {
        const config = JSON.parse(readFileSync(fixture.config, "utf8"));
        config.unexpected = true;
        writeFileSync(fixture.config, JSON.stringify(config));
      }
      const result = run(fixture, "assert-hop");
      expectFailure(
        result,
        invalid ? "root config changed outside permitted metadata" : "input read/write failed",
      );
      if (invalid) {
        expect(result.stderr).toContain("after-hop observation could not be saved");
      }
      expect(readFileSync(observationPath, "utf8")).toBe("retained evidence");
    },
  );

  it("rejects a completed repair that leaves the implicit roster unpersisted", () => {
    const fixture = makeFixture();
    prepareHop(fixture);
    expectSuccess(run(fixture, "assert-hop"));
    rewriteRoot(fixture, targetVersion, true);
    doctorOutput(fixture, "Doctor complete.\n", "repair");
    expectFailure(run(fixture, "assert-repair"), "required canonical agent roster missing");
    expect(existsSync(join(fixture.artifacts, "positive-config-converged.json"))).toBe(false);
  });

  it("rejects newline corruption in the newly inserted original-root backup", () => {
    const fixture = makeFixture();
    prepareHop(fixture);
    rewriteRoot(fixture, targetVersion);
    writeFileSync(`${fixture.config}.bak`, `${readFileSync(`${fixture.config}.bak`, "utf8")}\n`);
    expectFailure(run(fixture, "assert-hop"), "backup ring lost or rewrote recovery history");
  });

  it("rejects plausible root copies that erase the entire original backup history", () => {
    const fixture = makeFixture();
    prepareHop(fixture);
    const raw = readFileSync(fixture.config, "utf8");
    for (let index = 0; index < 5; index += 1) {
      const file = `${fixture.config}.bak${index ? `.${index}` : ""}`;
      if (existsSync(file)) {
        unlinkSync(file);
      }
      writeFileSync(file, raw, { mode: 0o600 });
    }
    expectFailure(
      run(fixture, "assert-hop"),
      "backup preservation proof inconclusive: no original history witness",
    );
  });

  it("reports full turnover as inconclusive even after five ordered writes", () => {
    const fixture = makeFixture();
    prepareHop(fixture);
    for (let index = 0; index < 5; index += 1) {
      rewriteRoot(fixture, targetVersion);
    }
    expectFailure(
      run(fixture, "assert-hop"),
      "backup preservation proof inconclusive: no original history witness",
    );
  });

  it("accepts the writer tightening surviving rotated backups from 0644 to 0600", () => {
    const fixture = makeFixture(false);
    chmodSync(`${fixture.config}.bak`, 0o644);
    chmodSync(`${fixture.config}.bak.1`, 0o644);
    expectSuccess(run(fixture, "seed", targetVersion));
    prepareHop(fixture);
    rewriteRoot(fixture, targetVersion);
    chmodSync(`${fixture.config}.bak.1`, 0o600);
    chmodSync(`${fixture.config}.bak.2`, 0o600);
    expectSuccess(run(fixture, "assert-hop"));
  });

  it("preserves unrotated permissions and requires canonical permissions after rotation", () => {
    for (const rotated of [false, true]) {
      const fixture = makeFixture(false);
      chmodSync(`${fixture.config}.bak`, 0o644);
      expectSuccess(run(fixture, "seed", targetVersion));
      prepareHop(fixture);
      if (rotated) {
        rewriteRoot(fixture, targetVersion);
        expectFailure(run(fixture, "assert-hop"), "backup ring lost or rewrote recovery history");
      } else {
        expectSuccess(run(fixture, "assert-hop"));
      }
    }
  });

  it("allows only the five source-backed Doctor provenance fields", () => {
    for (const unexpected of [false, true]) {
      const fixture = makeFixture();
      prepareHop(fixture);
      const config = JSON.parse(readFileSync(fixture.config, "utf8"));
      config.wizard = {
        lastRunAt: new Date().toISOString(),
        lastRunVersion: targetVersion,
        lastRunCommand: "doctor",
        lastRunMode: "local",
      };
      if (unexpected) {
        config.wizard.securityAcknowledgedAt = new Date().toISOString();
      }
      writeFileSync(fixture.config, JSON.stringify(config));
      if (unexpected) {
        expectFailure(run(fixture, "assert-hop"), "root config changed outside permitted metadata");
      } else {
        expectSuccess(run(fixture, "assert-hop"));
      }
    }
  });

  it.each([
    ["materialized ordinary reference", "responsePrefix", "first-hop-prefix"],
    ["lost escaped reference", "usageTemplate", "${UPGRADE_SURVIVOR_LITERAL}"],
  ])("rejects a %s without printing config values", (_label, field, value) => {
    const fixture = makeFixture();
    prepareHop(fixture);
    const leaf = join(fixture.root, "first-hop-messages-leaf.json");
    const config = JSON.parse(readFileSync(leaf, "utf8"));
    config[field] = value;
    writeFileSync(leaf, JSON.stringify(config));
    const result = run(fixture, "assert-hop");
    expectFailure(result, "file changed: first-hop-messages-leaf.json");
    expect(result.stderr).not.toContain(value);
    expect(result.stderr).not.toContain(fixture.root);
  });

  it.each(["flattened", "moved"])(
    "rejects a %s include even when effective values would match",
    (change) => {
      const fixture = makeFixture();
      prepareHop(fixture);
      const config = JSON.parse(readFileSync(fixture.config, "utf8"));
      config.messages =
        change === "flattened"
          ? JSON.parse(readFileSync(join(fixture.root, "first-hop-messages-leaf.json"), "utf8"))
          : { $include: "./first-hop-messages-leaf.json" };
      writeFileSync(fixture.config, JSON.stringify(config));
      expectFailure(run(fixture, "assert-hop"), "root config changed outside permitted metadata");
    },
  );

  it("rejects byte-only changes in a nested include", () => {
    const fixture = makeFixture();
    prepareHop(fixture);
    const leaf = join(fixture.root, "first-hop-messages-leaf.json");
    writeFileSync(leaf, `${readFileSync(leaf, "utf8")}\n`);
    expectFailure(run(fixture, "assert-hop"), "file changed: first-hop-messages-leaf.json");
  });

  it.each([
    [".bak.first-hop-manual", "file changed: openclaw.json.bak.first-hop-manual"],
    [".pre-update", "pre-update snapshot lost original root bytes"],
    [".bak", "backup ring lost or rewrote recovery history"],
  ])("rejects damaged %s recovery bytes", (suffix, error) => {
    const fixture = makeFixture();
    prepareHop(fixture);
    writeFileSync(`${fixture.config}${suffix}`, "{}\n");
    expectFailure(run(fixture, "assert-hop"), error);
  });

  it("rejects dropped or rewritten surviving backup history after a valid rotation", () => {
    const fixture = makeFixture();
    prepareHop(fixture);
    rewriteRoot(fixture, targetVersion);
    unlinkSync(`${fixture.config}.bak.2`);
    expectFailure(run(fixture, "assert-hop"), "backup ring lost or rewrote recovery history");
  });

  it.each(["bytes", "identity"])("rejects a fresh Doctor that rewrites %s", (kind) => {
    const fixture = makeFixture();
    prepareHop(fixture);
    expectSuccess(run(fixture, "assert-hop"));
    completeRepair(fixture);
    doctorOutput(fixture);
    const raw = readFileSync(fixture.config, "utf8");
    if (kind === "bytes") {
      writeFileSync(fixture.config, `${raw}\n`);
    } else {
      writeFileSync(`${fixture.config}.new`, raw, { mode: 0o600 });
      renameSync(`${fixture.config}.new`, fixture.config);
    }
    expectFailure(
      run(fixture, "assert-doctor"),
      "fresh Doctor changed converged config or backup bytes/identity",
    );
  });

  it.each([
    ["", "fresh Doctor did not complete"],
    [
      "Skipping doctor config write during legacy update handoff.\nDoctor complete.",
      "fresh Doctor skipped or refused config convergence",
    ],
    [
      "No config changes were written.\nDoctor complete.",
      "fresh Doctor skipped or refused config convergence",
    ],
    [
      'Run "openclaw doctor --fix" to apply changes.\nDoctor complete.',
      "fresh Doctor skipped or refused config convergence",
    ],
  ])("never treats skipped or absent Doctor proof as convergence", (output, error) => {
    const fixture = makeFixture();
    prepareHop(fixture);
    expectSuccess(run(fixture, "assert-hop"));
    completeRepair(fixture);
    doctorOutput(fixture, output);
    expectFailure(run(fixture, "assert-doctor"), error);
  });

  it("fails closed on missing proof and rejects seed collisions without replacing existing config", () => {
    const fixture = makeFixture(false);
    const raw = readFileSync(fixture.config, "utf8");
    writeFileSync(join(fixture.root, "first-hop-messages.json"), "{}");
    expectFailure(run(fixture, "seed", targetVersion), "fixture collision");
    expect(readFileSync(fixture.config, "utf8")).toBe(raw);
    expectFailure(run(fixture, "assert-hop"), "input read/write failed");
  });
});

describe.skipIf(process.platform === "win32")("first-hop preservation shell ordering", () => {
  it.each([
    "none",
    "hop",
    "repair-missing",
    "repair-refused",
    "repair-exit",
    "doctor",
    "doctor-exit",
  ])("stops before masking evidence when %s fails", (failure) => {
    const fixture = makeFixture(false);
    const positive = readFileSync(laneScript, "utf8").match(
      /^run_positive_hops\(\) \{[\s\S]*?^\}/mu,
    )?.[0];
    expect(positive).toBeDefined();
    const log = join(fixture.artifacts, "order.txt");
    writeFileSync(join(fixture.artifacts, "positive-before.pid"), "1\n");
    const result = spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
doctor_calls=0
setup_lane() { echo setup >> "$ORDER_LOG"; }
tar() { printf '{"version":"2026.9.5"}'; }
node() {
  if [ "$1" = scripts/e2e/lib/release-scenarios/assertions.mjs ]; then
    echo configure >> "$ORDER_LOG"
  else
    if [ "$1" = scripts/e2e/lib/upgrade-survivor/first-hop-config-preservation.mjs ]; then
      echo "preserve $2" >> "$ORDER_LOG"
    fi
    "$FIXTURE_NODE" "$@"
  fi
}
openclaw() {
  echo "$*" >> "$ORDER_LOG"
  if [ "$1" = doctor ]; then
    doctor_calls=$((doctor_calls + 1))
    if [ "$doctor_calls" = 1 ]; then
      if [ "$FAILURE" = repair-exit ]; then return 23; fi
      if [ "$FAILURE" = repair-refused ]; then
        echo 'Config fixes were not applied.'
      elif [ "$FAILURE" != repair-missing ]; then
        "$FIXTURE_NODE" -e '
          const fs = require("node:fs"), file = process.env.OPENCLAW_CONFIG_PATH;
          const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
          cfg.agents = { ...cfg.agents, entries: { main: {} } };
          cfg.plugins = { entries: { openai: { enabled: true } } };
          fs.writeFileSync(file, JSON.stringify(cfg));
        '
      fi
    else
      if [ "$FAILURE" = doctor-exit ]; then return 24; fi
      if [ "$FAILURE" = doctor ]; then printf '\\n' >> "$OPENCLAW_CONFIG_PATH"; fi
    fi
    echo 'Doctor complete.'
  else
    printf '{"valid":true}\\n'
  fi
}
run_update() {
  echo "$1" >> "$ORDER_LOG"
  : > "$ARTIFACT_DIR/$1.stdout"
  : > "$ARTIFACT_DIR/$1.stderr"
  if [ "$1" = positive-first ]; then
    cp "$OPENCLAW_CONFIG_PATH" "$OPENCLAW_CONFIG_PATH.pre-update"
    printf '2\\n' > "$OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE"
    if [ "$FAILURE" = hop ]; then
      printf '\\n' >> "$FIXTURE_ROOT/first-hop-messages-leaf.json"
    fi
  else
    printf '3\\n' > "$OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE"
  fi
}
assert_installed_build() { :; }
wait_service_active() { :; }
record_residue() { : > "$1"; }
assert_no_residue() { test ! -s "$1"; }
record_service_state() { : > "$1"; }
stop_lane() { echo stop >> "$ORDER_LOG"; }
${positive}
run_positive_hops
`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 15_000,
        env: {
          ...fixtureEnv(),
          ARTIFACT_DIR: fixture.artifacts,
          OPENCLAW_CONFIG_PATH: fixture.config,
          OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE: join(fixture.artifacts, "gateway.pid"),
          CANDIDATE_PACKAGE: "candidate.tgz",
          FUTURE_PACKAGE: "future.tgz",
          candidate_source_version: targetVersion,
          FIXTURE_ROOT: fixture.root,
          FIXTURE_NODE: process.execPath,
          ORDER_LOG: log,
          FAILURE: failure,
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(
      failure === "none" ? 0 : failure === "repair-exit" ? 23 : failure === "doctor-exit" ? 24 : 1,
    );
    const calls = readFileSync(log, "utf8").trim().split("\n");
    const expected = [
      "setup",
      "preserve seed",
      "config validate --json",
      "positive-first",
      "preserve assert-hop",
    ];
    if (failure !== "hop") {
      expected.push("config validate --json", "doctor --fix --non-interactive");
      if (failure !== "repair-exit") {
        expected.push("preserve assert-repair");
        if (!failure.startsWith("repair-")) {
          expected.push("doctor --fix --non-interactive");
          if (failure !== "doctor-exit") {
            expected.push("preserve assert-doctor");
            if (failure === "none") {
              expected.push("configure", "positive-second", "stop");
            }
          }
        }
      }
    }
    expect(calls).toStrictEqual(expected);
  });
});
