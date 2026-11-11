export function createDeploymentQuestion(header: string) {
  return {
    id: "deploy_target",
    header,
    question: "Where should this deploy?",
    options: [
      { label: "Staging (Recommended)", description: "Safer default" },
      { label: "Production" },
    ],
  };
}
