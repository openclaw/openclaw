export class SkillUploadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillUploadRequestError";
  }
}
