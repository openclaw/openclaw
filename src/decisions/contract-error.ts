/** A caller contract defect is not a provider outage. Never include evidence in errors. */
export class DecisionContractError extends Error {
  constructor() {
    super("Invalid decision contract; check the input and evaluation options.");
    this.name = "DecisionContractError";
  }
}
