import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../config/io.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import { runInitialConfigWriteHealth } from "../flows/doctor-health-contribution-runners.config.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import { useDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";

const note = vi.hoisted(() => vi.fn<(message: string, title?: string) => void>());
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));
const withHome = useDoctorConfigPreflightHome();
const html = (documents: string, id: string) => path.join(documents, id, "index.html");
const readHtml = (documents: string, id: string) => fs.readFile(html(documents, id), "utf8");

async function repair(configPath: string) {
  await using ctx = await prepareDoctorContext(configPath);
  await runInitialConfigWriteHealth(ctx);
  return JSON.parse(await fs.readFile(configPath, "utf8"));
}

afterEach(() => {
  note.mockClear();
  closeOpenClawStateDatabaseForTest();
});

function migrate(scenario: "blind" | "env-root" | "canonical-alias" | "legacy-root") {
  return withHome(async (home) => {
    const root = path.join(home, "custom-canvas");
    const documents = path.join(root, "documents");
    const core = path.join(home, ".openclaw", "canvas");
    const destination = path.join(core, "documents");
    const fails = scenario === "blind" || scenario === "env-root";
    const ids = fails ? ["cv_first", "cv_retry"] : ["cv_existing"];
    if (scenario === "canonical-alias") {
      await fs.mkdir(core, { recursive: true });
      await fs.symlink(core, root, "junction");
    }
    for (const id of ids) {
      await fs.mkdir(path.join(documents, id), { recursive: true });
      await fs.writeFile(html(documents, id), fails ? id : "existing");
    }
    const configuredRoot = scenario === "env-root" ? "${HOME}/custom-canvas" : root;
    const host = {
      enabled: false,
      root: configuredRoot,
      ...(scenario === "env-root" ? { port: 18793 } : {}),
    };
    const configPath = await writeOpenClawConfig(home, {
      gateway: { mode: "local" },
      ...(scenario === "legacy-root"
        ? { canvasHost: host }
        : {
            plugins: { entries: { canvas: { enabled: true, config: { host } } } },
          }),
    });
    if (fails) {
      const blocked = scenario === "blind" ? documents : html(documents, "cv_retry");
      await fs.chmod(blocked, 0);
      try {
        const saved = await repair(configPath);
        expect
          .soft(saved.plugins?.entries?.canvas?.config?.host?.root ?? saved.canvasHost?.root)
          .toBe(configuredRoot);
        if (scenario === "env-root") {
          // A committed partial repair must retain the root but remove the obsolete port.
          expect.soft(saved.plugins.entries.canvas.config.host).not.toHaveProperty("port");
        }
        const warnings = note.mock.calls
          .filter(([, title]) => title?.includes("warning"))
          .map(([message]) => message)
          .join("\n");
        for (const text of [
          "Canvas",
          "openclaw doctor --fix",
          scenario === "blind" ? "EACCES" : "cv_retry",
        ]) {
          expect.soft(warnings).toContain(text);
        }
        if (scenario === "env-root") {
          await expect(readHtml(destination, "cv_first")).resolves.toBe("cv_first");
          await expect(fs.access(path.join(destination, "cv_retry"))).rejects.toThrow();
          expect(await fs.readdir(destination)).toEqual(["cv_first"]);
        }
      } finally {
        await fs.chmod(blocked, scenario === "blind" ? 0o700 : 0o600);
      }
    }
    const saved = await repair(configPath);
    expect(saved.plugins?.entries?.canvas?.config?.host).toEqual({ enabled: false });
    if (!fails) {
      expect(Object.keys(saved.plugins.entries)).toEqual(["canvas"]);
      expect(saved).not.toHaveProperty("canvasHost");
    }
    expect((await readConfigFileSnapshot()).valid).toBe(true);
    for (const id of ids) {
      await expect(readHtml(destination, id)).resolves.toBe(fails ? id : "existing");
      if (fails) {
        await expect(fs.access(path.join(documents, id))).rejects.toThrow();
      }
    }
  });
}

// Windows and root ignore chmod(0); alias and legacy-root cases still run there.
it
  .skipIf(process.platform === "win32" || process.getuid?.() === 0)
  .each(["blind", "env-root"] as const)(
  "retains the root after a %s migration and retires it only after retry",
  migrate,
);
it.each(["canonical-alias", "legacy-root"] as const)(
  "retires a %s root without losing canonical documents",
  migrate,
);
