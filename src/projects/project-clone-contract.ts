import type { ProjectCloneFailureCause } from "../../packages/gateway-protocol/src/index.js";
export class ProjectCloneError extends Error {
  constructor(
    readonly failure: ProjectCloneFailureCause,
    message: string,
  ) {
    super(message);
    this.name = "ProjectCloneError";
  }
}
