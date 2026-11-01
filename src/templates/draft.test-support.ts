export function createResearchBriefProposal() {
  return {
    name: "research-brief",
    version: "0.1.0",
    scope: {
      input: "A research question and public sources.",
      job: "Compare sources and produce a cited brief.",
      output: "A short Markdown brief with links and uncertainties.",
      authority: "Read public sources. Ask before sending messages or spending money.",
    },
    manifest:
      "---\nschemaVersion: 1\nagent:\n  id: research-brief\n---\nCompare primary sources and cite every factual claim.\n",
    files: [],
  };
}
