export function buildNodesRunApprovalUnavailableMessage(nodeId: string) {
  return `exec denied: approval required (approval UI not available; open the Control UI with \`openclaw dashboard --no-open\` or check pending approvals with \`openclaw approvals get --node ${nodeId}\`)`;
}
