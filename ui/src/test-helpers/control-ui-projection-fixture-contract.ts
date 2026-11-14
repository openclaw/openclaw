import type { ProjectionResourceSnapshot } from "./control-ui-projection-resource-probe.ts";

export type CoreProjectionFamily = "agent-rows" | "outbox" | "board-pins";
export type SdkAvatarFamily = "sdk-avatars" | "sdk-avatar-identities";
export type InstanceResourceFamily =
  | "tooltips"
  | "link-providers"
  | "link-metadata"
  | "ci-pairs"
  | "clawhub-cards";
export type ProjectionFamily = CoreProjectionFamily | SdkAvatarFamily | InstanceResourceFamily;
export type ProjectionFixtureFacts = {
  family: ProjectionFamily;
  instrumented: boolean;
  mounted: { application: string; expected: number; actual: number }[];
  checkpoints: { phase: string; counts: ProjectionResourceSnapshot }[];
};

declare global {
  interface Window {
    openclawProjectionFixture?: {
      setup(family: ProjectionFamily, instrumented: boolean): Promise<ProjectionFixtureFacts>;
      run(): Promise<ProjectionFixtureFacts>;
      finish(): Promise<ProjectionFixtureFacts>;
      dispose(): void;
    };
  }
}
