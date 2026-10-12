import { Type } from "typebox";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import {
  bindAgentToolAvailability,
  getAgentToolAvailabilityBinding,
  type AgentToolAvailabilityBinding,
} from "../agent-tool-availability.js";
import type { SkillInstructionDeliveryMarkers } from "../agent-tools.read.js";
import {
  readInstalledSkill,
  searchInstalledSkills,
  type InstalledSkill,
} from "../installed-skill-catalog.js";
import { formatSkillInstructions } from "../skill-instruction-result.js";
import {
  asToolParamsRecord,
  jsonResult,
  readNumberParam,
  readToolStringParam,
  type AnyAgentTool,
} from "./common.js";

const SkillsSearchSchema = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 1000 }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
});
const SkillsReadSchema = Type.Object({ name: Type.String({ minLength: 1 }) });

export function createInstalledSkillTools(
  skills: readonly InstalledSkill[],
  delivery?: {
    /** Attempt-local per-invocation skill.used emission markers. */
    skillInstructionDeliveryMarkers?: SkillInstructionDeliveryMarkers;
  },
): AnyAgentTool[] {
  if (skills.length === 0) {
    return [];
  }
  const readerBinding: AgentToolAvailabilityBinding = { prepare() {} };
  let readAuthority: object | undefined;
  /** Resolve the delivery receipt for the bytes this invocation actually serves. */
  const resolveDeliveredFingerprint = async (
    name: string,
    content: string,
    cohort?: number,
  ): Promise<string | undefined> => {
    const skill = skills.find((entry) => entry.name === name);
    if (!skill) {
      return undefined;
    }
    // A live-tree entry acquires the identity of the bytes this serving read
    // returned and attributes it only when the acquired tree contains those
    // exact bytes. A retained or pinned entry provably serves its producer's
    // stamped bytes, so its stamp is the receipt. Anything else omits: the
    // serving boundary never borrows a preparation-time identity.
    if (skill.acquireDeliveredFingerprint) {
      try {
        return await skill.acquireDeliveredFingerprint(content, cohort);
      } catch {
        return undefined;
      }
    }
    return skill.attributableBundleFingerprint;
  };
  return [
    bindAgentToolAvailability<AnyAgentTool>(
      {
        name: "skills_search",
        label: "Search Installed Skills",
        description:
          "Find relevant installed, eligible skills by task or exact name, including skills omitted from the prompt directory. Searches names and descriptions, plus bounded instruction text when skill reads are allowed. Returns metadata only; coverage reports any incomplete body indexing. Read the selected skill's whole instructions before applying it. Does not search ClawHub or install anything.",
        parameters: SkillsSearchSchema,
        execute: async (_id, args, signal) => {
          signal?.throwIfAborted();
          const params = asToolParamsRecord(args);
          const authority = readAuthority;
          return jsonResult(
            await searchInstalledSkills(
              skills,
              readToolStringParam(params, "query", { required: true }),
              readNumberParam(params, "limit"),
              signal,
              () => authority !== undefined && readAuthority === authority,
            ),
          );
        },
      },
      {
        prepare(_tool, callableTools) {
          const reader = callableTools.get("skills_read");
          if (reader && getAgentToolAvailabilityBinding(reader) === readerBinding) {
            readAuthority ??= {};
          } else {
            // A regrant gets a new identity; work started under a revoked grant stays revoked.
            readAuthority = undefined;
          }
        },
      },
    ),
    bindAgentToolAvailability<AnyAgentTool>(
      {
        name: "skills_read",
        label: "Read Installed Skill",
        description:
          "Load complete SKILL.md instructions for an exact installed skill name. Use a known name directly; search is not required first. Does not execute the skill or grant additional tool permissions.",
        parameters: SkillsReadSchema,
        execute: async (toolCallId, args, signal) => {
          const params = asToolParamsRecord(args);
          const name = readToolStringParam(params, "name", { required: true });
          const instructions = await readInstalledSkill(skills, name, signal);
          const markers = delivery?.skillInstructionDeliveryMarkers;
          // The receipt cohort is the epoch this invocation's serving read
          // started in: a clear during that read rejects acquisition, so this
          // invocation never arms a walk a fresh generation could join.
          const invocationCohort = markers?.generation();
          // Telemetry acquisition never holds a completed read: it is bound to
          // this invocation's abort signal — an abort omits the receipt — and
          // the serving read's cancellation and currency checks are revalidated
          // after it, mirroring readInstalledSkill's own post-await gate.
          let fingerprint: string | undefined;
          if (
            markers &&
            invocationCohort !== undefined &&
            markers.generation() !== invocationCohort
          ) {
            fingerprint = undefined;
          } else {
            try {
              fingerprint = await racePromiseWithAbortSignal(
                resolveDeliveredFingerprint(name, instructions.content, invocationCohort),
                signal,
              );
            } catch {
              fingerprint = undefined;
            }
          }
          signal?.throwIfAborted();
          skills.find((entry) => entry.name === name)?.assertCurrent?.();
          if (
            markers &&
            fingerprint &&
            typeof toolCallId === "string" &&
            // An epoch clear that landed while the acquisition was pending
            // owns the markers now: this invocation started in a cleared
            // generation, so it never captures a receipt the next generation
            // could consume — a pending acquisition never bridges a clear.
            (invocationCohort === undefined || markers.generation() === invocationCohort)
          ) {
            // The receipt rides the invocation: the matcher consumes it at
            // emission instead of borrowing a preparation-time snapshot stamp.
            markers.captureInvocationFingerprint(toolCallId, fingerprint);
          }
          return {
            content: [{ type: "text", text: formatSkillInstructions(instructions) }],
            details: instructions,
          };
        },
      },
      readerBinding,
    ),
  ];
}
