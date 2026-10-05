/* @vitest-environment jsdom */
import { html, render, type ReactiveElement } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { ControlUiLinkReaderPreview } from "../../../../src/shared/control-ui-link-reader.js";
import { createContext, createGateway, createSessions } from "../../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import "./session-activity-git.ts";

const { snapshot } = vi.hoisted(() => ({ snapshot: vi.fn() }));
vi.mock("../../lib/session-pull-requests.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/session-pull-requests.ts")>()),
  sessionPullRequestsForGateway: () => ({
    get: snapshot,
    watch: vi.fn(),
    unwatch: vi.fn(),
    subscribe: () => () => {},
  }),
}));

afterEach(() => document.body.replaceChildren());

it.each(["github.com", "microsoft.ghe.com"])(
  "seeds the admitted PR author origin on %s and retains the session branch",
  async (host) => {
    const sessionKey = "agent:main:activity-pr";
    snapshot.mockReturnValue({
      status: "ready",
      rateLimited: false,
      branch: { owner: "bic", repo: "lobster", branch: "actual-session-branch" },
      pullRequests: [
        {
          owner: "bic",
          repo: "lobster",
          branch: "reviewed-branch",
          number: 16225,
          title: "Reviewed pull request",
          state: "open",
          author: { login: "reviewer" },
          url: `https://${host}/bic/lobster/pull/16225`,
        },
      ],
    });
    const context = createContext(
      createGateway(createTestGatewayClient(async () => ({}))),
      createSessions("main", [sessionKey]),
    );
    const container = document.createElement("div");
    document.body.append(container);
    render(
      html`<openclaw-activity-session-git
        .context=${context}
        .sessionKey=${sessionKey}
        agentId="main"
      ></openclaw-activity-session-git>`,
      container,
    );
    const element = container.firstElementChild as ReactiveElement;
    await element.updateComplete;
    const provider = element.querySelector(
      "openclaw-link-reader-hovercard-provider",
    ) as HTMLElement & { previewSeeds: ControlUiLinkReaderPreview[] };
    expect(provider.previewSeeds[0]?.authorUrl).toBe(`https://${host}/reviewer`);
    expect(element.querySelector(".activity-feed__branch")?.textContent).toContain(
      "actual-session-branch",
    );
  },
);
