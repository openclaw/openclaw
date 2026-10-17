import { clawDraftRelativePath } from "./draft.js";

export function clawDraftPrompt(draftId: string, sourceSessionKey?: string): string {
  return [
    "Create a private, unpublished Claw proposal from this agent's useful workflow.",
    sourceSessionKey
      ? `Use the relevant parts of source session ${JSON.stringify(sourceSessionKey)} that your normal session-history tools authorize you to read.`
      : "Inspect this agent's durable instructions and, if useful, a few relevant sessions available through your normal authorized history tools.",
    "Choose one useful, specific job. State its input, job, output, and authority boundary. Rewrite the workflow for another person; never export personal context.",
    "Do not read credentials to prepare this proposal. Exclude all memories, USER.md, personal facts, raw conversations, session logs, credentials, secret values, and local machine paths. Never copy the source workspace tree.",
    `Write ONLY to the proposal JSON at workspace-relative path ${JSON.stringify(clawDraftRelativePath(draftId))}. Read it first; it already exists. Preserve the JSON field names; replace the empty scope and starter manifest.`,
    "The document contains: name (lowercase unscoped slug), version (semver), scope {input, job, output, authority}, manifest (complete CLAW.md Markdown with YAML frontmatter), and files [{path, content}] containing only newly authored portable text.",
    "CLAW.md uses schemaVersion: 1 and agent: {id, name?}. Its body contains the portable agent instructions. Optional workspace.files entries are {source, path}; source names a file supplied in the proposal's files array and path is its destination in the new agent workspace.",
    "Keep useful skills, automations, and integration requirements explicit in the supported Claw manifest when required for the job. Use portable package references and credential requirements, never credential values. Explain any intentionally omitted or unavailable capability in the instructions. Do not claim an integration works without it.",
    "Do not publish, upload, run clawhub publish, or call any publication API. The person will review/edit the exact package and explicitly Publish from the Control UI. Report the proposed job and any limitations when the draft is ready.",
  ].join("\n\n");
}
