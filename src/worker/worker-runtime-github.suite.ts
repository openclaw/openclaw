import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type {
  WorkerLiveEventParams,
  WorkerTranscriptCommitParams,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerInferenceStartParams } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { runExec } from "../process/exec.js";
import type { WorkerLaunchDescriptor } from "./launch-descriptor.js";
import { createWorkerRuntimeEnvironment, runWorkerDescriptor } from "./worker.runtime.js";
type GitHubFixture = {
  sessionId: string;
  setup: (options?: { inferencePlans?: Array<"tool" | "text">; execCommand?: string }) => Promise<{
    gateway: {
      inferenceRequests: WorkerInferenceStartParams[];
      liveEventRequests: WorkerLiveEventParams[];
      transcriptRequests: WorkerTranscriptCommitParams[];
    };
    workspaceDir: string;
    launch: WorkerLaunchDescriptor;
  }>;
};
export function registerWorkerGitHubTests({ setup, sessionId }: GitHubFixture): void {
  // The probe uses a POSIX shell; Windows launches exec through PowerShell.
  it.skipIf(process.platform === "win32")(
    "binds the turn GitHub identity and checkout to real exec without publishing its token",
    async () => {
      const { gateway, workspaceDir, launch } = await setup({
        inferencePlans: ["tool", "text"],
        execCommand: [
          'printf "%s" "$GH_TOKEN" | if command -v shasum >/dev/null; then shasum -a 256; else sha256sum; fi | cut -d " " -f1',
          'printf "github-token=%s\\n" "$GITHUB_TOKEN"',
          'printf "helpers-start\\n"',
          "git config --get-all credential.helper",
          'printf "helpers-end\\n"',
          "git config --show-scope --get-all credential.helper",
          "git symbolic-ref HEAD",
          "git config --get remote.origin.url",
          'printf "profile=%s\\n" "$GH_CONFIG_DIR"',
        ].join("; "),
      });
      const binding = {
        token: "worker-turn-fixture-token",
        login: "worker-fixture",
        branch: "openclaw/session-fixture",
        remoteUrl: "https://github.com/openclaw/worker-fixture.git",
      };
      launch.assignment.github = binding;
      const environment = await createWorkerRuntimeEnvironment(sessionId);
      try {
        const git = async (args: string[]) =>
          await runExec("git", ["-C", workspaceDir, ...args], {
            timeoutMs: 10_000,
            maxBuffer: 4_096,
            logOutput: false,
          });
        await git(["init", "--quiet", "--initial-branch=openclaw-worker"]);
        await git([
          "-c",
          "user.name=Worker Fixture",
          "-c",
          "user.email=worker@openclaw.invalid",
          "commit",
          "--quiet",
          "--allow-empty",
          "--no-gpg-sign",
          "-m",
          "Worker base",
        ]);
        const baseCommit = (await git(["rev-parse", "HEAD"])).stdout.trim();
        const remote = path.join(environment.stateDir, "fixture-remote.git");
        await git(["clone", "--bare", "--quiet", workspaceDir, remote]);
        await git(["--git-dir", remote, "update-ref", `refs/heads/${binding.branch}`, baseCommit]);
        await git(["config", `url.${remote}.insteadOf`, binding.remoteUrl]);
        await writeFile(path.join(workspaceDir, ".git", "shallow"), `${baseCommit}\n`);

        await expect(
          runWorkerDescriptor(launch, { environmentStateDir: environment.stateDir }),
        ).resolves.toMatchObject({ status: "completed" });

        const toolResult = gateway.inferenceRequests[1]?.context.messages
          .filter((message) => message.role === "toolResult")
          .find((message) => message.toolName === "exec");
        expect(toolResult).toMatchObject({ isError: false });
        const profileDir = path.join(
          environment.stateDir,
          "github-profiles",
          createHash("sha256").update(launch.assignment.turnId).digest("hex").slice(0, 16),
        );
        const output =
          toolResult?.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n") ?? "";
        expect(output).toContain(
          [
            createHash("sha256").update(binding.token).digest("hex"),
            "github-token=",
            "helpers-start",
          ].join("\n"),
        );
        expect(output).toContain(
          [`refs/heads/${binding.branch}`, binding.remoteUrl, `profile=${profileDir}`].join("\n"),
        );
        expect(
          output
            .split("\n")
            .filter((line) => line.startsWith("command\t"))
            .map((line) => line.slice("command\t".length)),
        ).toEqual(["", "!gh auth git-credential"]);
        const helpers = output.split("helpers-start\n")[1]?.split("\nhelpers-end")[0]?.split("\n");
        // Git lists inherited helpers too; an empty value resets the effective helper list.
        expect(helpers?.slice(helpers.lastIndexOf(""))).toEqual(["", "!gh auth git-credential"]);
        expect((await stat(profileDir)).mode & 0o777).toBe(0o700);
        const hostsPath = path.join(profileDir, "hosts.yml");
        expect((await stat(hostsPath)).mode & 0o777).toBe(0o600);
        expect(await readFile(hostsPath, "utf8")).toContain(binding.login);
        expect(JSON.stringify(gateway.transcriptRequests)).not.toContain(binding.token);
        expect(JSON.stringify(gateway.liveEventRequests)).not.toContain(binding.token);
      } finally {
        await environment.close();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps exec unbound and creates no GitHub profile without a turn identity",
    async () => {
      // Direct in-process fixtures bypass the node supervisor's sanitized child environment.
      vi.stubEnv("GH_CONFIG_DIR", undefined);
      vi.stubEnv("GH_TOKEN", undefined);
      vi.stubEnv("GITHUB_TOKEN", undefined);
      const { gateway, launch } = await setup({
        inferencePlans: ["tool", "text"],
        execCommand: 'printf "profile=%s\\n" "${GH_CONFIG_DIR-unset}"',
      });
      const environment = await createWorkerRuntimeEnvironment(sessionId);
      try {
        await expect(
          runWorkerDescriptor(launch, { environmentStateDir: environment.stateDir }),
        ).resolves.toMatchObject({ status: "completed" });

        const toolResult = gateway.inferenceRequests[1]?.context.messages.find(
          (message) => message.role === "toolResult" && message.toolName === "exec",
        );
        expect(toolResult).toMatchObject({
          isError: false,
          content: [{ type: "text", text: expect.stringContaining("profile=unset") }],
        });
        await expect(
          stat(path.join(environment.stateDir, "github-profiles")),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await environment.close();
      }
    },
  );

  it("reports a GitHub profile write failure before running inference", async () => {
    const { gateway, launch } = await setup();
    launch.assignment.github = {
      token: "worker-profile-write-fixture-token",
      login: "worker-fixture",
      branch: "openclaw/session-fixture",
    };
    const environment = await createWorkerRuntimeEnvironment(sessionId);
    try {
      // A file in the root's parent path cannot be repaired by removing github-profiles.
      const blockedStateDir = path.join(environment.stateDir, "obstruction");
      await writeFile(blockedStateDir, "obstruction");
      await expect(
        runWorkerDescriptor(launch, { environmentStateDir: blockedStateDir }),
      ).rejects.toThrow("Worker GitHub identity profile could not be written:");
      expect(gateway.inferenceRequests).toHaveLength(0);
    } finally {
      await environment.close();
    }
  });
}
