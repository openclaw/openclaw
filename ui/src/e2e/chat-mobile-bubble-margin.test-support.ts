import type { Page } from "playwright";
import { projectChatDisplayMessages } from "../../../src/gateway/chat-display-projection.js";
import type { ControlUiMockGatewayScenario } from "../test-helpers/control-ui-e2e.ts";

const longText = `${"Please review the sample release checklist and explain the next useful step. ".repeat(17)}End of request.`;
const marginImageSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="teal"/><circle cx="480" cy="270" r="160" fill="gold"/></svg>';
const imageUrl = `data:image/svg+xml,${encodeURIComponent(marginImageSvg)}`;
const image = { type: "image", url: imageUrl, width: 960, height: 540 };
const mediaAttachment = (
  kind: string,
  label: string,
  mimeType: string,
  url: string,
  extra = {},
) => ({
  type: "attachment",
  attachment: { kind, label, mimeType, url, ...extra },
});
const file = mediaAttachment(
  "document",
  "release-checklist-with-a-long-file-name.txt",
  "text/plain",
  "https://example.com/checklist.txt",
  { sizeBytes: 1024 },
);
const preview = (kind: string, ext: string, mimeType: string) =>
  mediaAttachment(kind, `preview.${ext}`, mimeType, `https://media.example/preview.${ext}`);
const video = preview("video", "mp4", "video/mp4");
const audio = preview("audio", "mp3", "audio/mpeg");
const plugin = {
  type: "clawhub",
  kind: "plugin",
  id: "ch_sample",
  name: "Sample checklist plugin",
  description: "Review and share sample release checklists with your team.",
  official: true,
  installed: false,
};
const users = ["Riley", "Colin"].map((name, index) => ({
  id: name,
  name,
  self: index === 0,
  identity: { type: "profile" as const, id: name },
}));
const message = (role: string, content: unknown, extra = {}) => ({
  role,
  content,
  timestamp: 1_800_000_000_000,
  ...extra,
});
const forwarded = (sourceSessionKey: string, content: unknown) =>
  projectChatDisplayMessages([
    message("user", content, {
      provenance: { kind: "inter_session", sourceSessionKey, sourceTool: "sessions_send" },
    }),
  ]);

const surface = (
  id: string,
  messages: NonNullable<ControlUiMockGatewayScenario["historyMessages"]>,
  side: string,
  selector = ".chat-bubble",
) => ({ id, messages, side, selector });
const peer = (content: unknown) =>
  message("user", content, {
    __openclaw: { senderId: "Colin", senderIdentity: users[1]!.identity, senderName: "Colin" },
  });

const caseFor = (id: string, role: string, content: unknown, selector = ".chat-bubble") =>
  surface(id, [message(role, content)], role === "user" ? "right" : "left", selector);
const activity = (id: string, key: string, content: unknown = longText) =>
  surface(id, forwarded(key, content), "left", ".chat-session-activity");
const cardSelector = ".chat-assistant-attachment-card";
const remoteImage = "https://media.example/preview.png";

export const marginCases = [
  caseFor("user-long", "user", longText),
  caseFor("user-short", "user", "Ready."),
  surface("peer-long", [peer(longText)], "left"),
  ...["user", "assistant"].flatMap((role) => [
    caseFor(
      `${role}-file`,
      role,
      [file, { type: "text", text: "Please read this checklist." }],
      cardSelector,
    ),
    {
      ...caseFor(`${role}-image`, role, [image], ".chat-message-image"),
      imageSize: role === "assistant" ? { width: 960, height: 540 } : undefined,
    },
    caseFor(`${role}-video`, role, [video], role === "user" ? ".chat-video-preview" : cardSelector),
    caseFor(`${role}-audio`, role, [audio], cardSelector),
  ]),
  ...[
    { width: 320, height: 180, attachment: false },
    { width: 320, height: 180, attachment: true },
    { width: 960, height: 540, attachment: true },
  ].map(({ width, height, attachment }) =>
    Object.assign(
      caseFor(
        `assistant-${attachment ? "attachment-image" : "image"}-${width}`,
        "assistant",
        [
          attachment
            ? mediaAttachment("image", "sample.png", "image/png", remoteImage, { width, height })
            : { type: "image", url: remoteImage, width, height },
        ],
        ".chat-message-image",
      ),
      { imageSize: { width, height } },
    ),
  ),
  ...[2, 3, 5].map((count) =>
    caseFor(
      `user-gallery-${count}`,
      "user",
      Array.from({ length: count }, () => image),
      ".chat-message-images",
    ),
  ),
  surface("peer-gallery", [peer([image, image, image])], "left", ".chat-message-images"),
  caseFor("user-mixed", "user", [image, video, file, { type: "text", text: longText }]),
  ...[
    ["forwarded", "agent:main:cron:release-review"],
    ["other-agent", "agent:research:notes"],
    ["subagent", "agent:main:subagent:checklist"],
    ["legacy", "legacy-checklist"],
  ].map(([id, key]) => activity(id!, key!)),
  activity("forwarded-short", "agent:main:cron:release-review", "Review complete."),
  activity("forwarded-media", "agent:research:notes", [
    { ...image, url: remoteImage },
    file,
    { type: "text", text: "The sample checklist is ready." },
  ]),
  caseFor("clawhub", "assistant", [plugin], ".chat-clawhub-card"),
  {
    ...caseFor(
      "assistant-plain",
      "assistant",
      "A plain assistant response with a long line that should keep the full conversation width. ".repeat(
        4,
      ),
    ),
    excluded: true,
  },
  {
    ...caseFor("system-notice", "system", "The sample session is ready.", ".chat-notice"),
    excluded: true,
  },
] as const;

export type MarginCase = (typeof marginCases)[number];

export function marginScenario(testCase: MarginCase): ControlUiMockGatewayScenario {
  return {
    historyMessages: [...testCase.messages],
    presenceUsers: users,
    methodResponses: {
      "plugins.catalog.get": {
        plugin: {
          id: plugin.id,
          catalog: { name: plugin.name, summary: plugin.description },
          local: { installed: false, action: "install" },
        },
      },
    },
  };
}

export async function createMarginImage(
  page: Page,
  size = { width: 960, height: 540 },
): Promise<Buffer> {
  const encoded = await page.evaluate(({ width, height }) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")!.fillRect(0, 0, width, height);
    return canvas.toDataURL("image/png").split(",")[1]!;
  }, size);
  return Buffer.from(encoded, "base64");
}

export async function resizeMarginViewport(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 1200 });
  // Excluded cases have no mobile measurement between resizes. Await native
  // layout publication before issuing the desktop restore.
  await page.evaluate(
    (expectedWidth) =>
      new Promise<void>((resolve) => {
        const observer = new ResizeObserver(([entry]) => {
          if (
            window.innerWidth !== expectedWidth ||
            entry?.borderBoxSize[0]?.inlineSize !== expectedWidth
          ) {
            return;
          }
          observer.disconnect();
          resolve();
        });
        observer.observe(document.documentElement, { box: "border-box" });
      }),
    width,
  );
}

export async function measureMargin(page: Page, testCase: MarginCase) {
  const target = page.locator(`.chat-thread ${testCase.selector}`).first();
  await target.waitFor();
  await page
    .locator(".chat-thread img.chat-message-image")
    .evaluateAll((images: HTMLImageElement[]) =>
      Promise.all(images.map((element) => element.decode())),
    );
  await page.evaluate(() => document.fonts.ready);
  return target.evaluate((element, side) => {
    const group = element.closest(".chat-group") ?? element.closest(".chat-thread-inner")!;
    const column = group.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    const media = [...element.querySelectorAll(".chat-image-frame, img.chat-message-image, video")]
      .map((item) => item.getBoundingClientRect())
      .filter((rect) => rect.width > 0);
    const left = Math.min(box.left, ...media.map((rect) => rect.left));
    const right = Math.max(box.right, ...media.map((rect) => rect.right));
    return {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      columnWidth: column.width,
      open: side === "right" ? left - column.left : column.right - right,
      closed: side === "right" ? column.right - right : left - column.left,
      overflow: Math.max(0, element.scrollWidth - element.clientWidth),
      media: [...element.querySelectorAll("img, video")].map((mediaElement) => {
        const rect = mediaElement.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          left: rect.left - box.left,
          right: box.right - rect.right,
        };
      }),
    };
  }, testCase.side);
}
