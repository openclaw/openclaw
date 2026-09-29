// Real config CLI coverage for dry-run preview parity with the roster persistence guard.
import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { useConfigCliIntegrationHarness } from "./config-cli.integration.test-harness.js";

const { registeredRuntimeLogs, runRegisteredConfigCommand, withConfigFileHarness } =
  useConfigCliIntegrationHarness();

describe("config cli roster preview integration", () => {
  it("rejects emptying the roster in preview just like the commit (#133895)", async () => {
    const raw = JSON.stringify({ agents: { entries: { main: { default: true } } } });
    await withConfigFileHarness(
      "openclaw-config-cli-roster-empty-",
      raw,
      async ({ configPath }) => {
        const args = ["config", "set", "agents.entries", "{}", "--replace", "--strict-json"];
        // The commit rejects dropping the last roster entry; preview must match.
        for (const preview of [true, false]) {
          await expect(
            runRegisteredConfigCommand([...args, ...(preview ? ["--dry-run", "--json"] : [])]),
          ).rejects.toMatchObject({ name: "ExitError", code: 1 });
          expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        }
        expect(registeredRuntimeLogs.join("\n")).not.toContain("Updated");
      },
    );
  });

  it("previews an include-owned edit without tripping the root persistence guard", async () => {
    const includeRaw = '{"level":"info"}\n';
    const raw =
      JSON.stringify({
        agents: { entries: { main: { default: true } } },
        logging: { $include: "logging.json" },
      }) + "\n";
    await withConfigFileHarness(
      "openclaw-config-cli-roster-include-",
      raw,
      async ({ configPath, tempDir }) => {
        const includePath = path.join(tempDir, "logging.json");
        fs.writeFileSync(includePath, includeRaw);
        const args = ["config", "set", "logging.level", '"debug"', "--strict-json"];
        // The commit routes this edit to the owning include, so the preview must
        // skip the root-only persistence projection and succeed without writing.
        await runRegisteredConfigCommand([...args, "--dry-run"]);
        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        expect(fs.readFileSync(includePath, "utf8")).toBe(includeRaw);
        await runRegisteredConfigCommand(args);
        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        expect(JSON5.parse(fs.readFileSync(includePath, "utf8"))).toEqual({ level: "debug" });
      },
    );
  });

  it("previews an include-owned edit that topology preparation reshapes at the root", async () => {
    const raw =
      JSON.stringify({
        agents: {
          entries: { main: { default: true } },
          defaults: { sessionStore: { agentId: "main" } },
        },
        session: { $include: "session.json" },
      }) + "\n";
    await withConfigFileHarness(
      "openclaw-config-cli-roster-include-topology-",
      raw,
      async ({ configPath, tempDir }) => {
        const includePath = path.join(tempDir, "session.json");
        const storeA = path.join(fs.realpathSync(tempDir), "a.sqlite");
        const storeB = path.join(fs.realpathSync(tempDir), "b.sqlite");
        const includeRaw = `${JSON.stringify({ store: storeA })}\n`;
        fs.writeFileSync(includePath, includeRaw);
        const args = ["config", "set", "session.store", JSON.stringify(storeB), "--strict-json"];
        // Topology preparation removes the root-level session-store owner, so a
        // post-topology routing decision would see changes in both agents and
        // session and wrongly reject. The commit routes to the include writer
        // before topology preparation; the preview must decide from the same
        // pre-topology candidate.
        await runRegisteredConfigCommand([...args, "--dry-run"]);
        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        expect(fs.readFileSync(includePath, "utf8")).toBe(includeRaw);
        await runRegisteredConfigCommand(args);
        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        expect(JSON5.parse(fs.readFileSync(includePath, "utf8"))).toEqual({ store: storeB });
      },
    );
  });

  it("previews a no-op include-owned assignment without persistence rejection", async () => {
    const includeRaw = '{"level":"info"}\n';
    const raw =
      JSON.stringify({
        agents: { entries: { main: { default: true } } },
        logging: { $include: "logging.json" },
      }) + "\n";
    await withConfigFileHarness(
      "openclaw-config-cli-roster-include-noop-",
      raw,
      async ({ configPath, tempDir }) => {
        const includePath = path.join(tempDir, "logging.json");
        fs.writeFileSync(includePath, includeRaw);
        const args = ["config", "set", "logging.level", '"info"', "--strict-json"];
        // The committing command reports "No change" before persistence; the
        // preview must preserve that no-op path instead of rejecting the
        // include-owned explicit set.
        await runRegisteredConfigCommand([...args, "--dry-run"]);
        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        expect(fs.readFileSync(includePath, "utf8")).toBe(includeRaw);
        await runRegisteredConfigCommand(args);
        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        expect(fs.readFileSync(includePath, "utf8")).toBe(includeRaw);
        expect(registeredRuntimeLogs.join("\n")).toContain("No change");
      },
    );
  });

  it("previews an agents-include roster expansion under explicit ownership", async () => {
    const raw = JSON.stringify({ agents: { $include: "agents.json" } }) + "\n";
    await withConfigFileHarness(
      "openclaw-config-cli-roster-include-flag-",
      raw,
      async ({ configPath, tempDir }) => {
        const includePath = path.join(tempDir, "agents.json");
        const includeRaw =
          JSON.stringify({ ownership: "explicit", entries: { main: { name: "before" } } }) + "\n";
        fs.writeFileSync(includePath, includeRaw);
        const args = ["config", "set", "agents.entries.work", '{"name":"worker"}', "--strict-json"];
        // Entering multi-agent makes topology preparation derive
        // persistCanonicalAgentRoster, but the commit selects the include writer
        // before topology preparation without that derived flag. The preview
        // must route the same way instead of forcing the root writer.
        await runRegisteredConfigCommand([...args, "--dry-run"]);
        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        expect(fs.readFileSync(includePath, "utf8")).toBe(includeRaw);
        await runRegisteredConfigCommand(args);
        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        expect(JSON5.parse(fs.readFileSync(includePath, "utf8"))).toEqual({
          ownership: "explicit",
          entries: { main: { name: "before" }, work: { name: "worker" } },
        });
      },
    );
  });
});
