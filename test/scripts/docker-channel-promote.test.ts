import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  createDockerChannelPromotionPlan,
  promoteDockerChannel,
} from "../../scripts/docker-channel-promote.mjs";

const images = ["ghcr.io/openclaw/openclaw", "docker.io/openclaw/openclaw"];
const digest = `sha256:${"1".repeat(64)}`;

type WorkflowStep = {
  env?: Record<string, string>;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, boolean | string>;
};

type WorkflowJob = {
  concurrency?: { group?: string; "cancel-in-progress"?: boolean; queue?: string };
  environment?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
};

type Workflow = {
  concurrency?: { group?: string; "cancel-in-progress"?: boolean; queue?: string };
  jobs?: Record<string, WorkflowJob>;
};

function readWorkflow(path: string): Workflow {
  return parse(readFileSync(path, "utf8")) as Workflow;
}

function requireJob(workflow: Workflow, name: string): WorkflowJob {
  const job = workflow.jobs?.[name];
  if (!job) {
    throw new Error(`Missing workflow job: ${name}`);
  }
  return job;
}

describe("Docker channel promotion", () => {
  it("plans every extended-stable image variant in both registries", () => {
    expect(createDockerChannelPromotionPlan({ version: "2026.6.33", images })).toEqual({
      channel: "extended-stable",
      promotions: images.flatMap((image) => [
        {
          image,
          sourceRef: `${image}:2026.6.33`,
          targetRefs: [`${image}:extended-stable`],
        },
        {
          image,
          sourceRef: `${image}:2026.6.33-slim`,
          targetRefs: [`${image}:extended-stable-slim`],
        },
        {
          image,
          sourceRef: `${image}:2026.6.33-browser`,
          targetRefs: [`${image}:extended-stable-browser`],
        },
      ]),
      version: "2026.6.33",
    });
  });

  it("preflights every source before moving and verifying aliases", () => {
    const calls: string[][] = [];
    const targetDigests = new Map<string, string>();
    const execFileSyncImpl = vi.fn((_command: string, args: string[]) => {
      calls.push(args);
      if (args[2] === "inspect") {
        return JSON.stringify({ digest: targetDigests.get(args[3]!) ?? digest });
      }
      const sourceDigest = args.at(-1)!.split("@")[1]!;
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--tag") {
          targetDigests.set(args[index + 1]!, sourceDigest);
        }
      }
      return "";
    });

    promoteDockerChannel({ version: "2026.6.33", images }, { execFileSyncImpl });

    const firstCreate = calls.findIndex((args) => args[2] === "create");
    expect(firstCreate).toBe(6);
    expect(calls.slice(0, firstCreate).every((args) => args[2] === "inspect")).toBe(true);
    expect(calls.filter((args) => args[2] === "create")).toHaveLength(6);
    expect(execFileSyncImpl).toHaveBeenCalledWith(
      "docker",
      [
        "buildx",
        "imagetools",
        "create",
        "--prefer-index=false",
        "--tag",
        "ghcr.io/openclaw/openclaw:extended-stable",
        `ghcr.io/openclaw/openclaw@${digest}`,
      ],
      expect.objectContaining({ timeout: 120_000 }),
    );
  });

  it("fails without mutating when any immutable source is missing", () => {
    const calls: string[][] = [];
    const execFileSyncImpl = vi.fn((_command: string, args: string[]) => {
      calls.push(args);
      if (calls.length === 3) {
        throw new Error("missing manifest");
      }
      return JSON.stringify({ digest });
    });

    expect(() =>
      promoteDockerChannel({ version: "2026.6.33", images }, { execFileSyncImpl }),
    ).toThrow("missing manifest");
    expect(calls.some((args) => args[2] === "create")).toBe(false);
  });

  it("fails when a promoted alias does not match its immutable source", () => {
    const wrongDigest = `sha256:${"2".repeat(64)}`;
    const execFileSyncImpl = vi.fn((_command: string, args: string[]) => {
      if (args[2] === "inspect" && args[3]?.endsWith(":extended-stable")) {
        return JSON.stringify({ digest: wrongDigest });
      }
      return args[2] === "inspect" ? JSON.stringify({ digest }) : "";
    });

    expect(() =>
      promoteDockerChannel({ version: "2026.6.33", images }, { execFileSyncImpl }),
    ).toThrow(`resolved to ${wrongDigest}, expected ${digest}`);
  });

  it("rejects channels without moving aliases", () => {
    expect(() => createDockerChannelPromotionPlan({ version: "2026.7.2-beta.3", images })).toThrow(
      "no moving aliases",
    );
  });

  it("gates every registry mutation behind approval and attestation verification", () => {
    const workflow = readWorkflow(".github/workflows/docker-channel-promote.yml");
    const releaseWorkflow = readWorkflow(".github/workflows/docker-release.yml");
    const resolve = requireJob(workflow, "resolve");
    const approve = requireJob(workflow, "approve");
    const promote = requireJob(workflow, "promote");

    expect(releaseWorkflow.concurrency).toEqual({
      group:
        "${{ github.event_name == 'workflow_dispatch' && format('docker-release-manual-{0}', inputs.tag) || 'docker-release-publish' }}",
      "cancel-in-progress": false,
      queue: "max",
    });
    expect(resolve.permissions).toEqual({ contents: "read" });
    expect(resolve.steps?.find((step) => step.uses?.startsWith("actions/checkout@"))?.with).toEqual(
      expect.objectContaining({ ref: "${{ github.sha }}", "persist-credentials": false }),
    );
    expect(approve.needs).toBe("resolve");
    expect(approve.environment).toBe("docker-release");
    expect(approve.permissions).toEqual({});
    expect(promote.needs).toEqual(["resolve", "approve"]);
    expect(promote.permissions).toEqual({ contents: "read", packages: "write" });
    expect(promote.concurrency).toEqual({
      group: "docker-release-publish",
      "cancel-in-progress": false,
      queue: "max",
    });
    expect(promote.steps?.find((step) => step.uses?.startsWith("actions/checkout@"))?.with).toEqual(
      expect.objectContaining({ ref: "${{ github.sha }}", "persist-credentials": false }),
    );

    const steps = promote.steps ?? [];
    const attestationIndex = steps.findIndex(
      (step) => step.name === "Verify immutable source attestations",
    );
    const promotionIndex = steps.findIndex(
      (step) => step.name === "Promote and verify channel aliases",
    );
    expect(attestationIndex).toBeGreaterThan(-1);
    expect(promotionIndex).toBeGreaterThan(attestationIndex);

    const attestationRun = steps[attestationIndex]?.run ?? "";
    for (const ref of [
      "${GHCR_IMAGE}:${VERSION}",
      "${GHCR_IMAGE}:${VERSION}-slim",
      "${GHCR_IMAGE}:${VERSION}-browser",
      "${DOCKERHUB_IMAGE}:${VERSION}",
      "${DOCKERHUB_IMAGE}:${VERSION}-slim",
      "${DOCKERHUB_IMAGE}:${VERSION}-browser",
    ]) {
      expect(attestationRun).toContain(ref);
    }
    expect(attestationRun).toContain("node scripts/verify-docker-attestations.mjs");
    expect(attestationRun).toContain("--platform linux/amd64");
    expect(attestationRun).toContain("--platform linux/arm64");
    expect(steps[promotionIndex]?.run).toContain("node scripts/docker-channel-promote.mjs");

    const packageWriters = Object.entries(workflow.jobs ?? {}).filter(
      ([, job]) => job.permissions?.packages === "write",
    );
    expect(packageWriters.map(([name]) => name)).toEqual(["promote"]);
    expect(packageWriters[0]?.[1].needs).toContain("approve");
  });
});
