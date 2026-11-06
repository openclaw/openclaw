import { resolveInitialDoctorHealthContributions } from "./doctor-health-contributions-initial.js";

export function initialDoctorHealthContribution(id: string) {
  const unrelatedContribution = async () => {
    throw new Error("Unexpected unrelated Doctor contribution");
  };
  const contribution = resolveInitialDoctorHealthContributions({
    runStructuredHealthRepairs: unrelatedContribution,
    runGatewayConfigHealth: unrelatedContribution,
    runAuthProfileMigration: unrelatedContribution,
    runAuthProfileHealth: unrelatedContribution,
    runGatewayAuthHealth: unrelatedContribution,
    runLegacyStateHealth: unrelatedContribution,
  }).find((entry) => entry.id === id);
  if (!contribution) {
    throw new Error(`Missing Doctor contribution: ${id}`);
  }
  return contribution;
}
