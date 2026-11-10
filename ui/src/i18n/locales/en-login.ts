import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Recovery copy follows the lazy login and plugin views; the loader label stays eager.
const enLogin = {
  connection: {
    help: {
      title: "How to connect",
      step1: "Start the Gateway on this computer:",
      step2: "Get a one-time dashboard link:",
      step3: "Enter the Gateway URL and secret above, or open the link.",
      docsLink: "Read the docs →",
    },
  },
  login: {
    unsupportedBrowser: {
      title: "Update your browser to use OpenClaw",
      description:
        "This browser is missing features the Control UI needs to display menus and dialogs.",
      apple: "Use macOS 26.2 or iOS 26.2 or later, with Safari 26.2 or later.",
      browsers: "You can also use Chrome or Firefox released within the last six months.",
      native: "On an older Mac, open this dashboard in an up-to-date browser instead.",
      open: "Open in browser",
      opened: "Opened in your default browser.",
      failed: "Couldn’t open your browser. Copy this page’s address into an up-to-date browser.",
    },
    heading: "Connect to OpenClaw",
    lede: "Enter the Gateway URL and secret, or open the one-time link from openclaw dashboard on the computer running OpenClaw.",
    gatewayUrl: "Gateway URL",
    gatewaySettings: "Gateway settings",
    secret: "Gateway secret",
    setupCodeHint:
      "This is a device setup code for the OpenClaw mobile app, not the Gateway secret. Paste it in the app's Gateway settings instead; the Gateway secret comes from openclaw gateway auth-token --show on the Gateway host.",
    secretPlaceholder: "Paste the token or type the password",
    runOnHost: "Run on this computer",
    browserPair: {
      action: "Pair this browser",
      open: "Pair with a code instead",
      back: "Sign in with URL and secret",
      intro:
        "Pair your own browser for administrator access. This is not a guest invitation. Get a code here, then approve it on the Gateway host.",
      runOnGatewayHost: "Run on the Gateway host",
      reconnecting: "Connection interrupted. Retrying with the same code…",
      cancelling: "Withdrawing the request on the Gateway…",
      cancelled: "Pairing request withdrawn.",
      cancelFailed:
        "Could not confirm cancellation. The request may still be approved. Retry cancellation.",
      retryCancel: "Retry cancellation",
      alreadyApproved:
        "This browser was already approved. Cancel did not revoke its access. Choose Continue to connect.",
      continue: "Continue",
      getCode: "Get a code",
      starting: "Requesting a pairing code…",
      waiting: "Waiting for approval. Keep this page open.",
      identity: "Code {code} · Browser ID {id}",
      failure: {
        identityRequired:
          "This Gateway requires a verified identity. Use its normal identity-aware sign-in instead of browser code pairing.",
        declined: "This request was declined on the Gateway host.",
        expired: "This code expired. Pair this browser again for a new one.",
        busy: "Too many pairing requests right now. Wait a few minutes and try again.",
        unavailable: "This Gateway could not start pairing. Reload the page and try again.",
        noIdentity:
          "This browser could not create its device key. Open this Gateway over HTTPS or localhost.",
      },
    },
    connection: {
      target: "Connecting to {host}",
      secretEntered: "secret entered",
      noSecret: "no secret",
      change: "Change",
    },
    showSecret: "Show Gateway secret",
    hideSecret: "Hide Gateway secret",
    toggleSecretVisibility: "Toggle Gateway secret visibility",
    failure: {
      rawError: "Show details",
      busy: {
        title: "Gateway busy, retrying…",
        summary:
          "Couldn’t connect because the Gateway is busy. This page will retry automatically.",
        countdown: "Retrying in {seconds}s…",
        retrying: "Retrying now…",
      },
      profileUnavailable: {
        title: "Couldn’t verify your account",
        summary: "Couldn’t verify your account. Try again shortly.",
        stepRetry: "Retry shortly.",
        stepAdmin: "If this continues, ask an admin to check your account access.",
      },
      verifiedUserRequired: {
        title: "Verified identity required",
        summary: "Couldn’t verify your identity. Device and setup tokens don’t identify a person.",
        stepIdentity: "Sign in through the trusted proxy or Tailscale to verify your identity.",
        stepSharedSecret:
          "For trusted local admin access, use the shared Gateway token or password.",
      },
      accessDenied: {
        title: "No access to this Gateway",
        summary: "Couldn’t connect because your account doesn’t have access to this Gateway.",
        stepAdmin: "Ask an admin to grant or restore your access.",
        stepFindProfile:
          "Admins can find your profile with openclaw users list --json, then assign a role with users.setRole.",
        stepReconnect:
          "Sign in with a different account, or choose Connect after an admin grants access.",
      },
      authRequired: {
        title: "This Gateway expects its token",
        passwordTitle: "This Gateway expects its password",
        summary: "Couldn’t connect to {host}. Enter its token or password to continue.",
        stepPaste: "Paste the token from openclaw gateway auth-token --show into Gateway secret.",
        stepPassword: "Type the configured Gateway password into Gateway secret.",
        stepGenerate:
          "If no token is configured, run openclaw doctor --generate-gateway-token on the gateway host.",
        stepConnect: "Click Connect again after updating the Gateway secret.",
      },
      authFailed: {
        title: "Gateway secret rejected",
        summary:
          "Couldn’t connect with this token or password. Check that it belongs to this Gateway and try again.",
        stepDashboard:
          "Run openclaw dashboard --no-open for a fresh URL, or openclaw gateway auth-token --show to recover the token.",
        stepReplace: "Replace the Gateway secret with the token for this Gateway URL.",
      },
      bootstrapInvalid: {
        title: "Pairing link is no longer valid",
        summary:
          "Couldn’t use this one-time link. It may have expired or already been used. Get a new link instead of changing the Gateway secret.",
        stepOpen:
          "Open the new link in this browser. Pairing links work once and expire after ten minutes.",
        stepJson:
          "If the browser or clipboard is unavailable, run openclaw dashboard --json on the computer running OpenClaw and open its browserUrl in this browser.",
      },
      trustedProxy: {
        title: "Proxy authentication required",
        summary: "Couldn’t verify your proxy sign-in. Sign in through the proxy to continue.",
        stepSignIn: "Open the dashboard through the sign-in proxy, not the Gateway directly.",
        stepHeaders:
          "Ask an admin to check identity headers, required-header forwarding on WebSocket upgrade requests, and your account access.",
        stepNoToken: "A Gateway token cannot replace proxy authentication.",
      },
      rateLimited: {
        title: "Too many failed attempts",
        summary:
          "Couldn’t sign in because there were too many failed attempts. Wait before trying again.",
        stepStop: "Stop retrying from this tab for a moment.",
        stepWait: "Wait a few minutes, then reconnect with the correct token or password.",
        stepCheckClients:
          "On a shared computer, check whether other clients are retrying with the wrong token or password.",
      },
      pairing: {
        title: "Approve this browser",
        scopeTitle: "Approve the new access level",
        roleTitle: "Approve the new role",
        metadataTitle: "Re-approve this browser",
        restoreTitle: "Approve this browser again",
        restoreSummary:
          "Couldn’t connect to {host} because this browser’s {role} access is no longer active. The request asks for the same access it had before, nothing new. Approve it on the computer running OpenClaw.",
        roleSummary:
          "Couldn’t connect to {host} because this browser is asking for the {role} role, which it doesn’t have yet. Approve the request on the computer running OpenClaw.",
        scopeSummary:
          "Couldn’t connect to {host} because this browser is asking for more access: {scopes}. Approve the request on the computer running OpenClaw.",
        summary:
          "Couldn’t connect to {host} until this browser is approved. Approve it on the computer running OpenClaw.",
        upgradeSummary:
          "Couldn’t connect to {host} with the requested access. Approve the new request on the computer running OpenClaw.",
        stepDashboard:
          "For a one-time link, run openclaw dashboard on the computer running OpenClaw and open the link in this browser.",
        stepLatest: "Run the approve command it prints for the newest pending request.",
        stepReconnect: "Once approved, choose Connect.",
        waiting: "Waiting for approval… This page connects automatically once approved.",
        checkNow: "Check now",
        declinedTitle: "Access request declined",
        declinedSummary:
          "Couldn’t connect because this browser’s access request was declined. Automatic retries have stopped. You can request approval again.",
        expiredTitle: "Access request expired",
        expiredSummary:
          "Couldn’t connect because this browser’s access request expired. Request approval again to continue.",
        requestAgain: "Request again",
      },
      insecure: {
        title: "Secure browser context required",
        summary:
          "Couldn’t connect over HTTP because this browser needs a secure page to identify itself.",
        stepHttps:
          "Use HTTPS/Tailscale Serve, or open http://127.0.0.1:18789 on the computer running OpenClaw.",
        stepAvoidDisable:
          "Don’t use a remote HTTP URL. A token or password can’t replace browser device identity.",
      },
      origin: {
        title: "Browser origin not allowed",
        summary:
          "Couldn’t connect because this page’s address isn’t allowed. Ask an admin to allow it.",
        stepAllowedOrigins: "Add this browser origin to gateway.controlUi.allowedOrigins.",
        stepFullOrigin: "Use full origins such as http://localhost:5173, not wildcard patterns.",
        stepRestart: "Restart the Gateway after changing its allowed origins.",
      },
      protocol: {
        title: "Protocol mismatch",
        summary:
          "Couldn’t connect because this page and the Gateway use different versions. Reopen the dashboard.",
        refresh: "Refresh page",
        stepDashboard:
          "Reopen the served dashboard with openclaw dashboard so the UI and Gateway come from the same install.",
        stepDevUi:
          "If using pnpm ui:dev, rebuild or restart the dev UI against the current checkout.",
        stepRestart:
          "Restart the Gateway after updating OpenClaw so it serves the current protocol.",
      },
      network: {
        title: "Gateway unreachable",
        summary:
          "Couldn’t reach {host}. Check the URL and connection before trying another token or password.",
        stepGateway: "Confirm the Gateway is running with openclaw status or openclaw gateway run.",
        stepUrl:
          "Check the Gateway URL and use wss:// when the Gateway is behind HTTPS/Tailscale Serve.",
        stepDashboard:
          "Run openclaw dashboard --no-open on the computer running OpenClaw for the current URL and sign-in details.",
      },
    },
  },
} satisfies TranslationMap;

export const registerLoginEnglish = Object.assign(
  () => {
    Object.assign(en.connection.help, enLogin.connection.help);
    Object.assign(en.login, enLogin.login);
  },
  { catalog: enLogin },
);
