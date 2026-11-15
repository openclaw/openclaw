export class SkillResourceDeliveryLimitError extends Error {
  constructor() {
    super(
      "Selected skill resources exceed the worker delivery limit (8 MiB). Select fewer skills before retrying.",
    );
    this.name = "SkillResourceDeliveryLimitError";
  }
}
