export function createSuccessfulImageMediaDecision() {
  return {
    capability: "image",
    outcome: "success",
    attachments: [
      {
        attachmentIndex: 0,
        attempts: [
          {
            type: "provider",
            outcome: "success",
            provider: "openai",
            model: "gpt-5.2",
          },
        ],
        chosen: {
          type: "provider",
          outcome: "success",
          provider: "openai",
          model: "gpt-5.2",
        },
      },
    ],
  } as const;
}
