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

const withDoctorConfigPreflightHome = useDoctorConfigPreflightHome();

async function repairConfig(configPath: string) {
  await using ctx = await prepareDoctorContext(configPath);
  await runInitialConfigWriteHealth(ctx);
  return JSON.parse(await fs.readFile(configPath, "utf8"));
}

function writeCanvasConfig(home: string, root: string, legacy = false, port?: number) {
  const host = { enabled: false, root, ...(port ? { port } : {}) };
  return writeOpenClawConfig(home, {
    gateway: { mode: "local" },
    ...(legacy
      ? { canvasHost: host }
      : { plugins: { entries: { canvas: { enabled: true, config: { host } } } } }),
  });
}

const htmlPath = (documents: string, id: string) => path.join(documents, id, "index.html");
const readHtml = (documents: string, id: string) => fs.readFile(htmlPath(documents, id), "utf8");
async function writeHtml(documents: string, id: string, content = id) {
  await fs.mkdir(path.join(documents, id), { recursive: true });
  await fs.writeFile(htmlPath(documents, id), content);
}

afterEach(() => {
  note.mockClear();
  closeOpenClawStateDatabaseForTest();
});

// POSIX permissions exercise real read/copy failures; Windows and root ignore chmod(0).
it
  .skipIf(process.platform === "win32" || process.getuid?.() === 0)
  .each(["blind", "env-root"] as const)(
  "retains the root after a %s migration and retires it only after retry",
  (failure) =>
    withDoctorConfigPreflightHome(async (home) => {
      const customRoot = path.join(home, "custom-canvas");
      const documents = path.join(customRoot, "documents");
      const coreDocuments = path.join(home, ".openclaw", "canvas", "documents");
      for (const id of ["cv_first", "cv_retry"]) {
        await writeHtml(documents, id);
      }
      const configuredRoot = failure === "env-root" ? "${HOME}/custom-canvas" : customRoot;
      const configPath = await writeCanvasConfig(
        home,
        configuredRoot,
        false,
        failure === "env-root" ? 18793 : undefined,
      );
      const blockedPath = failure === "blind" ? documents : htmlPath(documents, "cv_retry");
      await fs.chmod(blockedPath, 0);
      try {
        const saved = await repairConfig(configPath);
        expect
          .soft(saved.plugins?.entries?.canvas?.config?.host?.root ?? saved.canvasHost?.root)
          .toBe(configuredRoot);
        if (failure === "env-root") {
          // Prove a committed partial repair, not just a refused config write.
          expect.soft(saved.plugins.entries.canvas.config.host).not.toHaveProperty("port");
        }
        const warnings = note.mock.calls
          .filter(([, title]) => title?.includes("warning"))
          .map(([message]) => message)
          .join("\n");
        for (const text of [
          "Canvas",
          "openclaw doctor --fix",
          failure === "blind" ? "EACCES" : "cv_retry",
        ]) {
          expect.soft(warnings).toContain(text);
        }
        if (failure === "env-root") {
          await expect(readHtml(coreDocuments, "cv_first")).resolves.toBe("cv_first");
          await expect(fs.access(path.join(coreDocuments, "cv_retry"))).rejects.toThrow();
          expect(await fs.readdir(coreDocuments)).toEqual(["cv_first"]);
        }
      } finally {
        await fs.chmod(blockedPath, failure === "blind" ? 0o700 : 0o600);
      }

      const saved = await repairConfig(configPath);
      expect(saved.plugins?.entries?.canvas?.config?.host).toEqual({ enabled: false });
      for (const id of ["cv_first", "cv_retry"]) {
        await expect(readHtml(coreDocuments, id)).resolves.toBe(id);
        await expect(fs.access(path.join(documents, id))).rejects.toThrow();
      }
      expect((await readConfigFileSnapshot()).valid).toBe(true);
    }),
);

it.each(["canonical-alias", "legacy-root"] as const)(
  "retires a %s root without losing canonical documents",
  (scenario) =>
    withDoctorConfigPreflightHome(async (home) => {
      const coreRoot = path.join(home, ".openclaw", "canvas");
      const customRoot = path.join(home, "custom-canvas");
      if (scenario === "canonical-alias") {
        await fs.mkdir(coreRoot, { recursive: true });
        await fs.symlink(coreRoot, customRoot, "junction");
      }
      const documents = path.join(customRoot, "documents");
      await writeHtml(documents, "cv_existing", "existing");
      const saved = await repairConfig(
        await writeCanvasConfig(home, customRoot, scenario === "legacy-root"),
      );
      expect(saved.plugins.entries.canvas.config.host).toEqual({ enabled: false });
      expect(Object.keys(saved.plugins.entries)).toEqual(["canvas"]);
      expect(saved).not.toHaveProperty("canvasHost");
      expect((await readConfigFileSnapshot()).valid).toBe(true);
      await expect(readHtml(path.join(coreRoot, "documents"), "cv_existing")).resolves.toBe(
        "existing",
      );
    }),
);
