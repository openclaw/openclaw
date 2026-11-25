export function overbroadBootstrapProfile() {
  return {
    roles: ["node", "operator"],
    scopes: [
      "node.exec",
      "operator.admin",
      "operator.approvals",
      "operator.pairing",
      "operator.read",
      "operator.talk.secrets",
      "operator.write",
    ],
  };
}
