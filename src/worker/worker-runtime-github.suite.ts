import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type {
  WorkerHeartbeatResult,
  WorkerLiveEventParams,
  WorkerTranscriptCommitParams,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerInferenceStartParams } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { createDeferred } from "../../test/helpers/promise.js";
import * as githubIdentity from "../agents/github-tool-identity.js";
import { runExec } from "../process/exec.js";
import { prepareSkillBundle } from "../skills/library/bundle.js";
import * as skillResources from "../skills/runtime/resources.js";
import type { WorkerLaunchDescriptor } from "./launch-descriptor.js";
import { createWorkerRuntimeEnvironment, runWorkerDescriptor } from "./worker.runtime.js";

type WorkerGitHubFixture = {
  setup: (options?: {
    inferencePlans?: Array<"tool" | "text" | "background-tool">;
    execCommand?: string;
    backgroundCommand?: string;
    inferenceRelease?: Promise<void>;
    githubRefresh?: WorkerHeartbeatResult["github"];
    heartbeatIntervalMs?: number;
  }) => Promise<{
    gateway: {
      inferenceRequests: WorkerInferenceStartParams[];
      acceptedTranscriptRequests: WorkerTranscriptCommitParams[];
      transcriptRequests: WorkerTranscriptCommitParams[];
      liveEventRequests: WorkerLiveEventParams[];
      waitForInferenceStart: () => Promise<void>;
    };
    workspaceDir: string;
    launch: WorkerLaunchDescriptor;
  }>;
  waitForFast: <T>(
    callback: () => T | Promise<T>,
    options?: { timeout?: number; interval?: number },
  ) => Promise<T>;
  sessionId: string;
};

export function registerWorkerGitHubTests({ setup, sessionId: SESSION_ID }: WorkerGitHubFixture) {
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
          "git remote get-url origin",
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
      const environment = await createWorkerRuntimeEnvironment(SESSION_ID);
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

  it("retires an in-flight GitHub profile write after terminal acknowledgment without losing the result", async () => {
    const inferenceRelease = createDeferred();
    const writeEntered = createDeferred();
    const writeRelease = createDeferred();
    const writeSettled = createDeferred();
    const cleanupEntered = createDeferred();
    const cleanupRelease = createDeferred();
    const snapshot = {
      generation: 1,
      token: "synthetic-retired-renewal",
      expiresAtMs: Date.now() + 3_600_000,
    };
    const { gateway, launch } = await setup({
      inferenceRelease: inferenceRelease.promise,
      githubRefresh: snapshot,
      heartbeatIntervalMs: 1,
    });
    launch.assignment.github = {
      token: "synthetic-current-token",
      login: "x-access-token",
      branch: "fixture",
    };
    const files = [{ path: "SKILL.md", content: "# Fixture\n", encoding: "utf8" as const }];
    launch.assignment.skillResources = {
      version: 1,
      skills: [
        {
          name: "fixture",
          description: "Fixture",
          files,
          revision: prepareSkillBundle(files).revision,
        },
      ],
    };
    const writeProfile = githubIdentity.writeManagedGitHubProfileFiles;
    let profileDir: string | undefined;
    const writer = vi
      .spyOn(githubIdentity, "writeManagedGitHubProfileFiles")
      .mockImplementation(async (...args) => {
        if (args[1].token !== snapshot.token) {
          return writeProfile(...args);
        }
        profileDir = args[0];
        writeEntered.resolve();
        await writeRelease.promise;
        try {
          await writeProfile(...args);
        } finally {
          writeSettled.resolve();
        }
      });
    const materialize = skillResources.materializeSkillResources;
    const resources = vi
      .spyOn(skillResources, "materializeSkillResources")
      .mockImplementation(async (...args) => {
        const prepared = await materialize(...args);
        return {
          ...prepared,
          cleanup: async () => {
            cleanupEntered.resolve();
            await cleanupRelease.promise;
            await prepared.cleanup();
          },
        };
      });
    const environment = await createWorkerRuntimeEnvironment(SESSION_ID);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const operation = runWorkerDescriptor(launch, { environmentStateDir: environment.stateDir });
    const settled = operation.catch(() => undefined);
    const waitForStage = (stage: Promise<void>, label: string) =>
      Promise.race([
        stage,
        operation.then(() => {
          throw new Error(`Worker completed before ${label}`);
        }),
      ]);
    try {
      await gateway.waitForInferenceStart();
      await vi.advanceTimersByTimeAsync(1);
      await waitForStage(writeEntered.promise, "credential profile publication");
      inferenceRelease.resolve();
      await waitForStage(cleanupEntered.promise, "terminal cleanup");
      expect(gateway.liveEventRequests.at(-1)?.event).toMatchObject({
        kind: "lifecycle",
        payload: { phase: "finishing" },
      });
      writeRelease.resolve();
      await waitForStage(writeSettled.promise, "credential publication settlement");
      if (!profileDir) {
        throw new Error("Credential heartbeat did not reach the profile writer");
      }
      const hosts = await readFile(path.join(profileDir, "hosts.yml"), "utf8");
      expect(hosts).toContain(launch.assignment.github.token);
      expect(hosts).not.toContain(snapshot.token);
      cleanupRelease.resolve();
      await expect(operation).resolves.toMatchObject({ status: "completed" });
    } finally {
      inferenceRelease.resolve();
      writeRelease.resolve();
      cleanupRelease.resolve();
      await settled;
      vi.useRealTimers();
      writer.mockRestore();
      resources.mockRestore();
      await environment.close();
    }
  });
}
