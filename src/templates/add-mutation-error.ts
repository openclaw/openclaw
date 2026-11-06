export class TemplateAddMutationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TemplateAddMutationError";
  }
}
