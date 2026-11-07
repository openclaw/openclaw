export type ControlUiRootState =
  | {
      kind: "bundled";
      path: string;
      realPath?: string;
      publicAssetBuildId?: string;
    }
  | { kind: "resolved"; path: string; realPath?: string }
  | { kind: "invalid"; path: string }
  | { kind: "preparing" }
  // The document route is unauthenticated; build diagnostics stay in Gateway logs.
  | { kind: "failed" }
  | { kind: "missing" };
