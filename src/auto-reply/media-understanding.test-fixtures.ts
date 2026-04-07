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
            model: "gpt-5.4",
          },
        ],
        chosen: {
          type: "provider",
          outcome: "success",
          provider: "openai",
          model: "gpt-5.4",
        },
      },
    ],
  } as const;
}
