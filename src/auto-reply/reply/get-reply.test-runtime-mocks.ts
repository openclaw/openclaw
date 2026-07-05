// Installs shared runtime mocks used by get-reply test modules.
import { vi } from "vitest";
<<<<<<< HEAD
import "./get-reply.test-mocks.js";
=======
import { registerGetReplyCommonMocks } from "./get-reply.test-mocks.js";

registerGetReplyCommonMocks();
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

vi.mock("../../link-understanding/apply.runtime.js", () => ({
  applyLinkUnderstanding: vi.fn(async () => undefined),
}));

vi.mock("../../media-understanding/apply.runtime.js", () => ({
  applyMediaUnderstanding: vi.fn(async () => undefined),
}));
