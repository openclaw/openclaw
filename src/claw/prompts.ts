type MissionFileContent = {
  name: string;
  content: string;
};

function renderMissionFiles(files: readonly MissionFileContent[]): string {
  return files
    .map((file) => [`## ${file.name}`, "", "```md", file.content.trim(), "```"].join("\n"))
    .join("\n\n");
}

export function buildClawRunnerExtraSystemPrompt(): string {
  return [
    "You are the persistent Claw mission runner inside OpenClaw.",
    "Operate only for the currently approved mission.",
    "Treat mission files and runtime mission state as the source of truth.",
    "Use tools autonomously to make real progress on the mission.",
    "Retry, re-plan, or research before asking the operator for help.",
    "Ask for help only on true blockers such as missing auth, missing runtime capability, or unrecoverable ambiguity.",
    "Update project files when the mission state changes materially.",
    'Never declare the mission done directly; hand off to verification by returning outcome "verify".',
    "End the turn with exactly one JSON object and no extra prose.",
  ].join("\n");
}

export function buildClawRunnerPrompt(params: {
  missionId: string;
  title: string;
  goal: string;
  status: string;
  currentStep?: string | null;
  blockedSummary?: string | null;
  recentEvidence: readonly string[];
  files: readonly MissionFileContent[];
}): string {
  const evidenceSection =
    params.recentEvidence.length > 0
      ? params.recentEvidence.map((item) => `- ${item}`).join("\n")
      : "- None yet.";
  return [
    "Execute one bounded Claw mission cycle.",
    "",
    `Mission ID: ${params.missionId}`,
    `Title: ${params.title}`,
    `Status: ${params.status}`,
    `Current step: ${params.currentStep ?? "n/a"}`,
    `Blocked summary: ${params.blockedSummary ?? "n/a"}`,
    "",
    "Goal:",
    params.goal,
    "",
    "Recent evidence:",
    evidenceSection,
    "",
    "Mission files:",
    renderMissionFiles(params.files),
    "",
    "Cycle contract:",
    "- Use tools if needed and make the strongest real progress you can in this cycle.",
    "- If the goal appears complete, return outcome \"verify\" instead of claiming success.",
    "- If truly blocked, return outcome \"blocked\" with the concrete blocker summary.",
    "- If the cycle encountered a meaningful failure but the mission should keep trying, return outcome \"continue\" with progress=false.",
    "",
    "Return exactly one JSON object with this shape:",
    '```json\n{"outcome":"continue|verify|blocked|failed","summary":"what happened","currentStep":"current mission step","nextStep":"optional next step","progress":true,"blockerSummary":"optional","blockerDetail":"optional","evidence":["short evidence item"]}\n```',
  ].join("\n");
}

export function buildClawVerifierExtraSystemPrompt(): string {
  return [
    "You are the Claw verifier.",
    "You are a fresh-context verification pass and must not trust the runner by default.",
    "Inspect the current mission files and repository state directly.",
    "Judge completion only against the explicit done criteria.",
    "End the turn with exactly one JSON object and no extra prose.",
  ].join("\n");
}

export function buildClawVerifierPrompt(params: {
  missionId: string;
  title: string;
  goal: string;
  currentStep?: string | null;
  recentEvidence: readonly string[];
  files: readonly MissionFileContent[];
}): string {
  const evidenceSection =
    params.recentEvidence.length > 0
      ? params.recentEvidence.map((item) => `- ${item}`).join("\n")
      : "- None captured.";
  return [
    "Run a fresh verification pass for this Claw mission.",
    "",
    `Mission ID: ${params.missionId}`,
    `Title: ${params.title}`,
    `Current step: ${params.currentStep ?? "n/a"}`,
    "",
    "Goal:",
    params.goal,
    "",
    "Execution evidence:",
    evidenceSection,
    "",
    "Mission files:",
    renderMissionFiles(params.files),
    "",
    "Verification contract:",
    "- Use tools if needed to inspect the repository or produced artifacts.",
    "- The mission is only done when PROJECT_DONE_CRITERIA.md is satisfied.",
    "- If criteria are not met, reject completion with concrete unmet criteria and the next step.",
    "",
    "Return exactly one JSON object with this shape:",
    '```json\n{"outcome":"done|reject|blocked","summary":"verification result","nextStep":"optional next step","unmetCriteria":["criterion still unmet"],"blockerSummary":"optional","evidence":["short evidence item"]}\n```',
  ].join("\n");
}
