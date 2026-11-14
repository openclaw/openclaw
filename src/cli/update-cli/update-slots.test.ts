import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

vi.mock("../../infra/container-environment.js", () => ({ isContainerEnvironment: () => false }));

async function owner(root: string) {
  const { resolveUpdateOwner } = await import("./update-slots.js");
  return await resolveUpdateOwner(root, "latest");
}

it("updates npm installs and git checkouts through runtime slots", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", temporary.make("openclaw-update-owner-state-"));
  const prefix = temporary.make("openclaw-update-owner-");
  const npmRoot = path.join(prefix, "lib", "node_modules", "openclaw");
  fs.mkdirSync(npmRoot, { recursive: true });
  const gitRoot = path.join(prefix, "checkout");
  fs.mkdirSync(path.join(gitRoot, ".git"), { recursive: true });
  await expect(owner(npmRoot)).resolves.toMatchObject({ kind: "slots", git: false });
  await expect(owner(gitRoot)).resolves.toMatchObject({ kind: "slots", git: true });
});

it.runIf(process.platform !== "win32")(
  "names the Homebrew command instead of updating a formula install",
  async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", temporary.make("openclaw-update-owner-state-"));
    const prefix = fs.realpathSync(temporary.make("openclaw-update-owner-brew-"));
    vi.stubEnv("HOMEBREW_PREFIX", prefix);
    const root = path.join(prefix, "Cellar", "openclaw-cli", "2026.11.3", "libexec");
    fs.mkdirSync(root, { recursive: true });
    await expect(owner(root)).resolves.toEqual({
      kind: "external",
      reason: "homebrew-install",
      message: "Homebrew owns this OpenClaw. Update it with: brew upgrade openclaw-cli",
    });
  },
);

it("names the app updater for an app-owned install", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", temporary.make("openclaw-update-owner-state-"));
  const root = path.join(temporary.make("openclaw-update-owner-app-"), "node_modules", "openclaw");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "openclaw-install-owner.json"),
    JSON.stringify({
      schemaVersion: 1,
      owner: "macos-app",
      displayName: "OpenClaw.app",
      updateHint: "Update OpenClaw.app from its menu.",
    }),
  );
  await expect(owner(root)).resolves.toMatchObject({
    kind: "external",
    reason: "app-owned-install",
    message: "Managed by OpenClaw.app. Update OpenClaw.app from its menu.",
  });
});
