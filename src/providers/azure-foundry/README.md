# Azure Foundry Provider

Integrates Azure AI Foundry / Azure OpenAI models into OpenClaw for chat, STT, and TTS.

## Auth

- Chat: `Authorization: Bearer <apiKey>`
- STT/TTS: `api-key: <apiKey>` (Azure cognitive services convention)

## Endpoint styles

- Native Azure AI Inference: `/models/chat/completions?api-version=2024-05-01-preview`
- OpenAI-compatible facade: `/openai/v1/chat/completions`

## Env aliases

OpenClaw checks these env vars in priority order:

- **API key:** `AZURE_FOUNDRY_API_KEY`, `AZURE_OPENAI_API_KEY`, `AZURE_INFERENCE_CREDENTIAL`, `AZURE_AI_API_KEY`
- **Endpoint:** `AZURE_FOUNDRY_ENDPOINT`, `AZURE_OPENAI_ENDPOINT`, `AZURE_INFERENCE_ENDPOINT`, `AZURE_AI_ENDPOINT`
- **API version:** `AZURE_FOUNDRY_API_VERSION`, `AZURE_OPENAI_API_VERSION`

## Built-in model catalog

GPT-4o, GPT-4o Mini, GPT-4.1, GPT-4.1 Mini, GPT-4.1 Nano, o3-mini, o4-mini,
DeepSeek R1, Phi-4, Mistral Large 2411, Meta Llama 3.1 405B, Cohere Command R+.

Additional models are discovered automatically from the `/models` endpoint when
credentials are available.

## Docs

See [docs/providers/azure-foundry.md](/docs/providers/azure-foundry.md) for full setup guide.
