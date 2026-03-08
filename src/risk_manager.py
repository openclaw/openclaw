import functools
import json
import os
from typing import Optional

import aiohttp

class RiskValidationException(Exception):
    """Raised when the Risk Manager blocks a transaction."""
    pass

class RiskManager:
    """
    Brigade: Dmarket
    Role: Risk Manager
    Model: deepseek-r1:14b (CUDA reasoning model)
    """
    def __init__(self, ollama_url: Optional[str] = None):
        self.ollama_url = ollama_url or os.environ.get("OLLAMA_URL", "http://localhost:11434")
        self.model = "deepseek-r1:14b"

    async def validate_transaction(self, endpoint: str, payload: dict) -> bool:
        """
        Queries the LLM to analyze the risk of a specific Dmarket API transaction.
        Requires keep_alive=0 to flush VRAM after reasoning.
        """
        prompt = (
            "You are the Risk Manager for a Dmarket trading bot. "
            "Analyze the following API transaction payload for dangerous parameters "
            "(e.g., buying items above market price, selling items too cheap, zero balances).\n"
            f"Endpoint: {endpoint}\n"
            f"Payload: {json.dumps(payload)}\n\n"
            "If the transaction appears safe, reply strictly with 'APPROVED'. "
            "If it violates risk parameters, reply with 'REJECTED' followed by the reason."
        )

        api_payload = {
            "model": self.model,
            "prompt": prompt,
            "stream": False,
            "keep_alive": "30s", # Smart flush for batching instead of instant 0
            "options": {
                "num_ctx": 4096
            }
        }

        async def _run_inference():
            async with aiohttp.ClientSession() as session:
                try:
                    async with session.post(f"{self.ollama_url}/api/generate", json=api_payload) as response:
                        if response.status == 200:
                            data = await response.json()
                            llm_response = data.get("response", "").strip().upper()
                            # DeepSeek-R1 outputs thought blocks <think>...</think>. Need to check if APPROVED is in output.
                            if "APPROVED" in llm_response and "REJECTED" not in llm_response:
                                return True
                            else:
                                print(f"[Risk Manager] Transaction BLOCKED: {llm_response}")
                                return False
                        return False
                except Exception as e:
                    print(f"[Risk Manager] Exception making request: {e}")
                    return False
                    
        from src.task_queue import model_queue
        return await model_queue.enqueue(self.model, _run_inference)

# Global instance for the decorator to use
_risk_manager = RiskManager()

def dmarket_risk_validation(endpoint_name: str):
    """
    Async decorator that intercepts calls to Dmarket API functions.
    Validates the kwargs payload against the Risk Manager before executing.
    """
    def decorator(func):
        @functools.wraps(func)
        async def wrapper(*args, **kwargs):
            print(f"[Interceptor] Validating request to {endpoint_name}...")
            
            # Extract payload (assuming payload is passed as a kwarg or first dict arg)
            payload = kwargs.get('payload', {})
            if not payload and args and isinstance(args[-1], dict):
                 payload = args[-1]
                 
            is_approved = await _risk_manager.validate_transaction(endpoint_name, payload)
            
            if not is_approved:
                raise RiskValidationException(f"Transaction to '{endpoint_name}' was blocked by the Risk Manager LLM.")
            
            print("[Interceptor] Transaction APPROVED by Risk Manager.")
            return await func(*args, **kwargs)
        return wrapper
    return decorator

# ======= Example Usage =======
class MockDmarketAPI:
    @dmarket_risk_validation("POST /api/v1/buy")
    async def buy_item(self, payload: dict):
        print(f"Executing Buy Order: {payload}")
        return {"status": "success"}

async def run_demo():
    api = MockDmarketAPI()
    try:
        # NOTE: Will fail if Ollama is not running locally.
        await api.buy_item(payload={"item_id": "12345", "price": 100.50})
    except RiskValidationException as e:
        print(f"Validation Failed: {e}")
