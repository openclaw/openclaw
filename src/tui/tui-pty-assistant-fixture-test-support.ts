/** Generated-script fragment for assistant-specific PTY fixture messages. */
export const TUI_PTY_ASSISTANT_FIXTURE_SCRIPT = `

  function buildAttachmentOnlyAssistantMessage(prompt: string, runId: string) {
    if (prompt !== "attachment-only assistant proof") {
      return null;
    }
    record("attachmentOnlyComplete", { runId });
    return {
      role: "assistant",
      content: [
        {
          type: "image",
          data: "SECRET_PTY_IMAGE_BYTES",
          url: "file:///Users/operator/private/image.png",
          artifactId: "SECRET_PTY_ARTIFACT",
        },
      ],
      timestamp: Date.now(),
    };
  }
`;
