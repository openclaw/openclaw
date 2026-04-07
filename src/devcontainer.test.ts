import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const devcontainerDir = join(repoRoot, ".devcontainer");

describe(".devcontainer", () => {
  describe("devcontainer.json", () => {
    it("exists and is valid JSON", async () => {
      const raw = await readFile(join(devcontainerDir, "devcontainer.json"), "utf8");
      const config = JSON.parse(raw);
      expect(config).toBeDefined();
      expect(config.name).toBe("OpenClawDev");
    });

    it("uses a local Dockerfile build", async () => {
      const config = JSON.parse(
        await readFile(join(devcontainerDir, "devcontainer.json"), "utf8"),
      );
      expect(config.build).toBeDefined();
      expect(config.build.dockerfile).toBe("Dockerfile");
    });

    it("runs on-create script as post-create command", async () => {
      const config = JSON.parse(
        await readFile(join(devcontainerDir, "devcontainer.json"), "utf8"),
      );
      expect(config.postCreateCommand).toContain("on-create.sh");
    });

    it("does not forward ports by default", async () => {
      const config = JSON.parse(
        await readFile(join(devcontainerDir, "devcontainer.json"), "utf8"),
      );
      expect(config.forwardPorts).toBeUndefined();
    });

    it("does not use fragile bind mounts for auth", async () => {
      const config = JSON.parse(
        await readFile(join(devcontainerDir, "devcontainer.json"), "utf8"),
      );
      expect(config.mounts).toBeUndefined();
    });

    it("passes ANTHROPIC_API_KEY from host environment", async () => {
      const config = JSON.parse(
        await readFile(join(devcontainerDir, "devcontainer.json"), "utf8"),
      );
      const env = config.remoteEnv ?? {};
      expect(env.ANTHROPIC_API_KEY).toBe("${localEnv:ANTHROPIC_API_KEY}");
    });

    it("passes GH_TOKEN from host environment", async () => {
      const config = JSON.parse(
        await readFile(join(devcontainerDir, "devcontainer.json"), "utf8"),
      );
      const env = config.remoteEnv ?? {};
      expect(env.GH_TOKEN).toBe("${localEnv:GH_TOKEN}");
    });

    it("sets the workspace folder to the repo mount", async () => {
      const config = JSON.parse(
        await readFile(join(devcontainerDir, "devcontainer.json"), "utf8"),
      );
      expect(config.workspaceFolder).toBe("/workspaces/openclaw");
    });
  });

  describe("Dockerfile", () => {
    it("exists in .devcontainer/", async () => {
      const s = await stat(join(devcontainerDir, "Dockerfile"));
      expect(s.isFile()).toBe(true);
    });

    it("is based on Debian bookworm Node image", async () => {
      const dockerfile = await readFile(join(devcontainerDir, "Dockerfile"), "utf8");
      expect(dockerfile).toMatch(/FROM\s+.*node.*bookworm/);
    });

    it("installs GitHub CLI", async () => {
      const dockerfile = await readFile(join(devcontainerDir, "Dockerfile"), "utf8");
      expect(dockerfile).toContain("gh");
      expect(dockerfile).toMatch(/github.*cli|cli\.github\.com/i);
    });

    it("installs Claude CLI via npm", async () => {
      const dockerfile = await readFile(join(devcontainerDir, "Dockerfile"), "utf8");
      expect(dockerfile).toContain("@anthropic-ai/claude-code");
    });

    it("installs Copilot as a gh extension", async () => {
      const dockerfile = await readFile(join(devcontainerDir, "Dockerfile"), "utf8");
      expect(dockerfile).toContain("gh extension install github/gh-copilot");
    });

    it("enables corepack for pnpm", async () => {
      const dockerfile = await readFile(join(devcontainerDir, "Dockerfile"), "utf8");
      expect(dockerfile).toContain("corepack enable");
    });

    it("installs common dev utilities", async () => {
      const dockerfile = await readFile(join(devcontainerDir, "Dockerfile"), "utf8");
      expect(dockerfile).toContain("git");
      expect(dockerfile).toContain("curl");
      expect(dockerfile).toContain("openssh-client");
    });

    it("does not run as root by default", async () => {
      const dockerfile = await readFile(join(devcontainerDir, "Dockerfile"), "utf8");
      expect(dockerfile).toMatch(/USER\s+node/);
    });
  });

  describe("on-create script", () => {
    it("exists in .devcontainer/", async () => {
      const s = await stat(join(devcontainerDir, "on-create.sh"));
      expect(s.isFile()).toBe(true);
    });

    it("runs pnpm install", async () => {
      const script = await readFile(join(devcontainerDir, "on-create.sh"), "utf8");
      expect(script).toContain("pnpm install");
    });

    it("checks GitHub CLI auth status", async () => {
      const script = await readFile(join(devcontainerDir, "on-create.sh"), "utf8");
      expect(script).toContain("gh auth status");
    });

    it("checks ANTHROPIC_API_KEY", async () => {
      const script = await readFile(join(devcontainerDir, "on-create.sh"), "utf8");
      expect(script).toContain("ANTHROPIC_API_KEY");
    });

    it("auto-configures git identity from GitHub when possible", async () => {
      const script = await readFile(join(devcontainerDir, "on-create.sh"), "utf8");
      expect(script).toContain("gh api user");
      expect(script).toContain("git config --global user.name");
    });

    it("checks SSH agent forwarding", async () => {
      const script = await readFile(join(devcontainerDir, "on-create.sh"), "utf8");
      expect(script).toContain("SSH_AUTH_SOCK");
    });
  });

  describe("documentation", () => {
    it("has a devcontainer install page", async () => {
      const s = await stat(join(repoRoot, "docs", "install", "devcontainer.md"));
      expect(s.isFile()).toBe(true);
    });

    it("docs navigation includes the devcontainer page", async () => {
      const docsJson = await readFile(join(repoRoot, "docs", "docs.json"), "utf8");
      expect(docsJson).toContain("install/devcontainer");
    });

    it("devcontainer doc covers Docker and Podman usage", async () => {
      const doc = await readFile(
        join(repoRoot, "docs", "install", "devcontainer.md"),
        "utf8",
      );
      expect(doc.toLowerCase()).toContain("docker");
      expect(doc.toLowerCase()).toContain("podman");
    });

    it("devcontainer doc covers host auth passthrough", async () => {
      const doc = await readFile(
        join(repoRoot, "docs", "install", "devcontainer.md"),
        "utf8",
      );
      expect(doc.toLowerCase()).toContain("ssh");
      expect(doc).toContain("gh auth");
      expect(doc).toContain("ANTHROPIC_API_KEY");
    });

    it("devcontainer doc covers in-container authentication", async () => {
      const doc = await readFile(
        join(repoRoot, "docs", "install", "devcontainer.md"),
        "utf8",
      );
      expect(doc).toContain("gh auth login");
      expect(doc).toContain("claude");
    });
  });
});
