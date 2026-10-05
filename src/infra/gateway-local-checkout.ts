/** TeamClaw keeps repository checkouts on workers, never on its Gateway state mount. */
export function assertGatewayLocalCheckoutAllowed(env: NodeJS.ProcessEnv): void {
  if (env.OPENCLAW_GATEWAY_CHECKOUTS_DISABLED === "1") {
    throw new Error("Gateway repository checkouts are disabled; select a remote worker.");
  }
}
