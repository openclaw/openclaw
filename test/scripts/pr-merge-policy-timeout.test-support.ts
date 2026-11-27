export const policyTimeoutCapture =
  "error: string rewrite policy unavailable or invalid (class=timeout attempt_utc=2026-09-22T10:13:23.286138Z elapsed_ms=12339)\n";

export const policyTimeoutQualification = {
  kind: "octopool-0.7.1-policy-timeout-refusal",
  producer: "octopool",
  command: "pr merge",
  version: "0.7.1",
  sourceRevision: "7ab9b348c99a7be4fdc82c75cb06ebce44e0007e",
  executableSha256: "2d732a74133cc68481b453afc630c7ca6651ad5a613931ad777c3bc6b1b17d7e",
  diagnosticsEnabled: true,
  sourceSha256: {
    "cmd/octopool/main.go": "4f953ba8def54614a5baf99f3747f0786996225f12a0d7cb4ad7d7bb4e817ef3",
    "cmd/octopool/gh.go": "0e22e7631e3b363689709dc5216e94ceb9177f8e4e539e40433d36b80d14a53d",
    "cmd/octopool/gh_fallback.go":
      "a23e05a735e8f2ed2c8fd6432c4983947dffc9d7b04c1c9e2acd680b45325605",
    "cmd/octopool/string_rewrites_guard.go":
      "2b5e768575554582c41f076401e0408b082b44dcf09b5fc5e040c9c66adafdec",
    "cmd/octopool/string_rewrites_policy.go":
      "ab422f237f06ea9f1b24b5342dced2aae80f59aaa782aaef6c3dd300275bcc41",
    "cmd/octopool/string_rewrites_diagnostic.go":
      "a7b1cce841174517f9e42cb8d8ec3d6f156420c4743b1a5b5f9c9b3c30b4bcbd",
    "cmd/octopool/gh_merge_diagnostics.go":
      "611c1e0bce036778b635b801192230af33d940fafcf923803ca643a21e68cf93",
    "cmd/octopool/string_rewrites_pr.go":
      "b32cb960537f5ffa1336a7689674afba9b4a2485b05e449acd2684a251ff8970",
  },
} as const;
