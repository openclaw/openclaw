export class CronReceiptAuthorityRefusal extends Error {
  constructor(
    readonly reason: "retired" | "unavailable" | "permission" | "spent" | "busy",
    options?: ErrorOptions,
  ) {
    super(`Cron effect authority ${reason}; prepare a new use from the live occurrence.`, options);
    this.name = "CronReceiptAuthorityRefusal";
  }
}
