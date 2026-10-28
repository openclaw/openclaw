export const runtimeProcessHelperManifest = {
  "workspace-rsync-receiver": { source: "src/worker/workspace-rsync-receiver.ts", sealed: false },
  "github-exec-launcher": { source: "src/agents/github-exec-launcher.ts", sealed: false },
  "gitlab-exec-launcher": { source: "src/agents/gitlab-exec-launcher.ts", sealed: false },
  "service-child-relay": { source: "src/process/supervisor/service-child-relay.ts", sealed: true },
  "service-child-group-anchor": {
    source: "src/process/supervisor/service-child-group-anchor.ts",
    sealed: true,
  },
} as const;
