import asyncio, aiohttp, json

async def test():
    api_key = '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'
    url = 'https://openrouter.ai/api/v1/chat/completions'
    headers = {
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://openclaw.ai',
        'X-Title': 'OpenClaw Bot'
    }
    payload = {
        'model': 'nvidia/nemotron-3-super-120b-a12b:free',
        'messages': [{'role': 'user', 'content': 'Say hello in one word'}],
        'max_tokens': 16,
        'stream': False
    }
    async with aiohttp.ClientSession() as session:
        async with session.post(url, json=payload, headers=headers, timeout=aiohttp.ClientTimeout(total=30)) as resp:
            status = resp.status
            data = await resp.json()
            print(f'Status: {status}')
            if status == 200:
                print(f'Model: {data["model"]}')
                print(f'Response: {data["choices"][0]["message"]["content"]}')
                print('OK - OpenRouter works!')
            else:
                print(f'Error: {json.dumps(data, indent=2)}')

asyncio.run(test())
