import asyncio
from typing import Dict, List, Callable, Tuple

class ModelTaskQueue:
    """
    Groups LLM inference requests by model name to batch sequential execution.
    Guarantees that if multiple tasks request the same model, they are
    executed sequentially without context switches in between.
    """
    def __init__(self):
        # model -> list of (future, func, args, kwargs)
        self.tasks: Dict[str, List[Tuple[asyncio.Future, Callable, tuple, dict]]] = {}
        self.lock = asyncio.Lock()
        self.worker_task = None
        self.current_model = None

    async def enqueue(self, model: str, func: Callable, *args, **kwargs):
        """
        Submits an async function 'func' to be executed when the GPU is loaded
        with 'model'.
        """
        future = asyncio.Future()
        async with self.lock:
            if model not in self.tasks:
                self.tasks[model] = []
            self.tasks[model].append((future, func, args, kwargs))
            
            if self.worker_task is None or self.worker_task.done():
                self.worker_task = asyncio.create_task(self._process_queue())
                
        return await future

    async def _process_queue(self):
        while True:
            async with self.lock:
                # Find the next model to process. Prioritize the currently loaded model.
                if self.current_model and self.tasks.get(self.current_model):
                    model_to_run = self.current_model
                else:
                    # Find any model that has pending tasks
                    available_models = [m for m, t in self.tasks.items() if t]
                    if not available_models:
                        self.worker_task = None
                        return
                    model_to_run = available_models[0]
                
                # Pop the first task for this model
                task = self.tasks[model_to_run].pop(0)
                self.current_model = model_to_run

            future, func, args, kwargs = task
            try:
                result = await func(*args, **kwargs)
                if not future.done():
                    future.set_result(result)
            except Exception as e:
                if not future.done():
                    future.set_exception(e)

# Global queue instance
model_queue = ModelTaskQueue()
