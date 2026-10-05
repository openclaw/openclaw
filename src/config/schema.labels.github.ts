export const GITHUB_TOOL_FIELD_LABELS: Record<string, string> = {
  "tools.github": "GitHub CLI Identity and Git Author",
  "tools.github.profileId": "GitHub Profile Version",
  "tools.github.kind": "GitHub Credential Kind",
  ...Object.fromEntries(
    ["tools.github", "agents.entries.*.tools.github"].flatMap((prefix) =>
      Object.entries({
        app: "GitHub App Installation",
        "app.appId": "App ID",
        "app.installationId": "Installation ID",
        "app.accountId": "Installation Owner ID",
        "app.repositories": "Admitted Repositories",
        "app.permissions": "Requested Permissions",
        "app.privateKey": "Gateway App Private Key",
        "app.keyVersion": "App Key Version",
      }).map(([key, value]) => [`${prefix}.${key}`, value]),
    ),
  ),
  "tools.github.gitAuthor.name": "Git Author Name",
  "tools.github.gitAuthor.email": "Git Author Email",
  "agents.entries.*.tools.github": "Agent GitHub CLI Identity Override",
  "agents.entries.*.tools.github.allowInSandbox": "Allow Agent GitHub Identity in Sandbox",
  "agents.entries.*.tools.github.profileId": "Agent GitHub Profile Version",
  "agents.entries.*.tools.github.kind": "Agent GitHub Credential Kind",
  "agents.entries.*.tools.github.gitAuthor.name": "Agent Git Author Name",
  "agents.entries.*.tools.github.gitAuthor.email": "Agent Git Author Email",
};
