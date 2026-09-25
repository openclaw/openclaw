import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  encodeSupervisedOperationRequest,
  type SupervisedOperationRequest,
} from "./supervised-operation.types.js";
import type { SupervisedGoal } from "./supervised-task.types.js";

// Git identities forbid ASCII controls and angle delimiters, not non-ASCII names.
function isGitIdentityText(value: string, minimum: number): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < minimum || code === 127 || code === 60 || code === 62) {
      return false;
    }
  }
  return true;
}

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/);
const text = z.string().min(1).max(4096);
const relativePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !path.posix.isAbsolute(value) &&
      !path.win32.isAbsolute(value) &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      value.split("/").every((part) => part !== ".." && part !== ".git"),
    "Expected an in-workspace relative path without Git metadata",
  );
const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.isAbsolute(value) && !value.includes("\0"), "Expected an absolute path");
const repository = z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/);
const branch = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      !value.startsWith("-") &&
      !value.startsWith("/") &&
      !/[\s~^:?*[\\]/u.test(value) &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.endsWith(".lock"),
    "Invalid branch reference",
  );
const timeoutMs = z.number().int().min(1000).max(3_600_000);
const ProfileSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("command"),
    id,
    executable: absolutePath,
    executableSha256: z.string().regex(/^[a-f0-9]{64}$/),
    argv: z.array(z.string().max(4096)).max(128),
    cwd: relativePath.default("."),
    timeoutMs,
    // Full workspace access is an explicit accepted capability. Network and host
    // home/state are never implicitly mounted into the command sandbox.
    writable: z.boolean().default(false),
    network: z.literal(false).default(false),
    readOnlyPaths: z
      .array(
        z.strictObject({
          path: absolutePath,
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      )
      .max(16)
      .default([]),
    replay: z.enum(["safe", "reconcile"]).default("reconcile"),
    resourceLimits: z
      .strictObject({
        memoryBytes: z
          .number()
          .int()
          .min(512 * 1024 * 1024)
          .max(8 * 1024 * 1024 * 1024),
        tasks: z.number().int().min(16).max(512),
        workingBytes: z
          .number()
          .int()
          .min(8 * 1024 * 1024)
          .max(1024 * 1024 * 1024),
        workingInodes: z.number().int().min(128).max(65536),
      })
      .refine(
        (limits) =>
          limits.memoryBytes % 4096 === 0 &&
          limits.memoryBytes >= 384 * 1024 * 1024 + limits.workingBytes + 128 * 1024 * 1024,
        "Memory must cover frozen inputs, working storage and 128 MiB process headroom",
      )
      .default({
        memoryBytes: 1024 * 1024 * 1024,
        tasks: 128,
        workingBytes: 64 * 1024 * 1024,
        workingInodes: 32768,
      }),
  }),
  z.strictObject({
    kind: z.literal("review"),
    id,
    runtime: z.enum(["codex", "claude-cli"]),
    agentId: id,
    model: z.string().min(3).max(128),
    instructions: text,
    paths: z.array(relativePath).min(1).max(128),
    maxBytes: z
      .number()
      .int()
      .min(1024)
      .max(256 * 1024)
      .default(64 * 1024),
    timeoutMs,
  }),
  z.strictObject({
    kind: z.literal("publication"),
    id,
    repository,
    pushRepository: repository,
    baseBranch: branch,
    baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
    branch,
    publisher: z.strictObject({
      agentId: id,
      accountId: z.number().int().positive(),
      login: z.string().regex(/^[a-zA-Z0-9-]+$/),
      source: z.enum(["system-detected", "system-configured", "agent-override"]),
      profileId: id.optional(),
      signingKey: z.string().regex(/^[A-Fa-f0-9]{16,64}$/),
      gitAuthor: z.strictObject({
        name: z
          .string()
          .trim()
          .min(1)
          .max(256)
          .refine((value) => isGitIdentityText(value, 32)),
        email: z
          .email()
          .max(256)
          .refine((value) => isGitIdentityText(value, 33)),
      }),
    }),
    title: z.string().min(1).max(256),
    body: z.string().max(16384),
    draft: z.literal(true).default(true),
    timeoutMs,
  }),
  z.strictObject({
    kind: z.literal("ci"),
    id,
    publicationProfile: id,
    requiredChecks: z
      .array(
        z.strictObject({
          name: z.string().min(1).max(256),
          appId: z.number().int().positive(),
        }),
      )
      .min(1)
      .max(64),
    pollIntervalMs: z.number().int().min(1000).max(300_000).default(30_000),
    timeoutMs,
  }),
]);
export type SupervisedWorkflowProfile = z.infer<typeof ProfileSchema>;

const AcceptanceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("receipts"),
    criterionId: id,
    profiles: z.array(id).min(1).max(32),
  }),
  z.strictObject({
    kind: z.literal("artifact"),
    criterionId: id,
    path: relativePath,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({
    kind: z.literal("json"),
    criterionId: id,
    path: relativePath,
    // Declarative data checks only; no executable predicate supplied by a model.
    fields: z.record(
      z.string().min(1).max(128),
      z.union([z.string().max(4096), z.boolean(), z.number().finite(), z.null()]),
    ),
  }),
  z.strictObject({ kind: z.literal("operator"), criterionId: id }),
]);

export const SupervisedWorkflowContractSchema = z
  .strictObject({
    version: z.literal(1),
    workspace: absolutePath,
    sourcePaths: z.array(relativePath).min(1).max(128).default(["."]),
    // The acceptance surface is fixed before model execution. Tool-written tests
    // may be useful, but cannot replace these host-accepted commands/criteria.
    profiles: z.array(ProfileSchema).max(64),
    acceptance: z.array(AcceptanceSchema).min(1).max(32),
    maxRecoveryAttempts: z.number().int().min(0).max(8).default(3),
    retentionDays: z.number().int().min(1).max(365).default(30),
  })
  .superRefine((contract, ctx) => {
    const profiles = new Map(contract.profiles.map((profile) => [profile.id, profile]));
    if (
      profiles.size !== contract.profiles.length ||
      new Set(contract.acceptance.map((rule) => rule.criterionId)).size !==
        contract.acceptance.length
    ) {
      ctx.addIssue({ code: "custom", message: "Profile and criterion IDs must be unique" });
    }
    for (const profile of contract.profiles) {
      if (
        profile.kind === "ci" &&
        profiles.get(profile.publicationProfile)?.kind !== "publication"
      ) {
        ctx.addIssue({ code: "custom", message: "CI must name an accepted publication profile" });
      }
    }
    for (const rule of contract.acceptance) {
      if (
        rule.kind === "receipts" &&
        (new Set(rule.profiles).size !== rule.profiles.length ||
          rule.profiles.some((key) => !profiles.has(key)))
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Acceptance names duplicate or unknown operation profiles",
        });
      }
    }
  });
export type SupervisedWorkflowContract = z.infer<typeof SupervisedWorkflowContractSchema>;

export function encodeSupervisedWorkflowContract(value: unknown, goal?: SupervisedGoal | null) {
  const contract = SupervisedWorkflowContractSchema.parse(value);
  if (
    goal &&
    (goal.success.length !== contract.acceptance.length ||
      goal.success.some(
        (criterion) => !contract.acceptance.some((rule) => rule.criterionId === criterion.id),
      ))
  ) {
    throw new Error(
      "Every accepted goal criterion requires exactly one controller acceptance rule",
    );
  }
  // Schemas fix object field order; sort only data-map entries, preserving arrays.
  contract.acceptance = contract.acceptance.map((rule) =>
    rule.kind === "json"
      ? {
          ...rule,
          fields: Object.fromEntries(
            Object.entries(rule.fields).toSorted((left, right) => {
              // Preserve default tuple string ordering used by persisted request/contract hashes.
              const a = String(left);
              const b = String(right);
              return a < b ? -1 : a > b ? 1 : 0;
            }),
          ),
        }
      : rule,
  );
  const json = JSON.stringify(contract);
  if (Buffer.byteLength(json) > 64 * 1024) {
    throw new Error("Workflow contract exceeds 64 KiB");
  }
  return { contract, json, hash: createHash("sha256").update(json).digest("hex") };
}

export function authorizeSupervisedWorkflowRequest(
  contract: SupervisedWorkflowContract,
  value: unknown,
): {
  request: SupervisedOperationRequest;
  profile: SupervisedWorkflowProfile;
} {
  const { request } = encodeSupervisedOperationRequest(value);
  const profile = contract.profiles.find(
    (candidate) => candidate.id === request.profile && candidate.kind === request.kind,
  );
  if (!profile || Object.keys(request.input).length) {
    throw new Error("Operation is not one of the accepted immutable profiles");
  }
  return { request, profile };
}
