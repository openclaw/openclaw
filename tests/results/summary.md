# Ollama Model Test Results

Tested: 45 Ollama models (2026-03-28)

## Summary

| Test                 | Passed | Failed | Success Rate |
| -------------------- | ------ | ------ | ------------ |
| Coding (hello world) | 34     | 11     | 76%          |
| Tool Calling         | 15     | 30     | 33%          |
| Planning             | 35     | 10     | 78%          |

## Models That Passed All 3 Tests

- qwen2.5:0.5b
- granite4:350m
- llama3.2:3b
- granite4:3b
- granite4:1b
- mistral:7b
- llama3-groq-tool-use:8B
- qwen2.5:7b-instruct
- llama3.1:8B
- mistral-nemo:latest
- gpt-oss:20b
- mistral-small:latest
- mistral-small3.2:latest
- mistral-small3.1:latest

## Models That Passed 2/3 Tests

- qwen2.5-coder:0.5b (coding, planning)
- qwen2.5-coder:1.5b (coding, planning)
- qwen2.5-coder:3b (coding, planning)
- qwen2.5-coder:7b (coding, planning)
- qwen2.5-coder:14b (coding, planning)
- deepseek-coder:1.3b (coding, planning)
- granite3.1-moe:1b (coding, planning)
- granite3.1-dense:2b (coding, planning)
- granite3.1-moe:3b (coding, planning)
- codellama:7b (coding, planning)
- deepseek-coder:6.7b (coding, planning)
- dolphincoder:7b (coding, planning)
- dolphincoder:15b (coding, planning)
- llama3:8B (coding, planning)
- deepseek-r1:7b (planning only)
- starcoder2:7b (planning only)
- dolphin-mistral:7b (coding, planning)
- yi-coder:1.5b (coding, planning)
- yi-coder:9b (coding, planning)
- llava:latest (coding, planning)

## Failed All Tests

- nomic-embed-text:v1.5 (embedding model)
- nomic-embed-text:latest (embedding model)
- bge-m3:latest (embedding model)
- qllama/bge-reranker-v2-m3:f16 (reranker model)
- xitao/bge-reranker-v2-m3:latest (reranker model)
- MedAIBase/Qwen3-VL-Reranker:2b (reranker model)
- deepseek-r1:1.5b (returns empty content - reasoning model needs special prompting)
- deepseek-coder:1.3b (refuses some prompts)

## Notes

- Embedding and reranker models expected to fail (not text generation)
- Tool calling hardest - only 33% pass rate
- With more system resources, more models passed
- deepseek-r1:1.5b is a reasoning model - needs different prompting style
