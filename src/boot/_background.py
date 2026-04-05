"""Background tasks — Memory GC loop and Remote Polling (extracted from OpenClawGateway)."""

import asyncio
import hashlib
import os
import time

import structlog

logger = structlog.get_logger("Background")


async def scheduled_memory_gc(gateway):
    """Background task to run Memory GC every 24 hours."""
    logger.info("Memory GC background loop started (24h interval)")
    while True:
        try:
            await asyncio.sleep(86400)
            logger.info("Triggering scheduled Memory GC compression...")

            gc = gateway.memory_gc
            memory_bank_dir = os.path.join(
                os.path.dirname(os.path.abspath(__file__)), "..", "..", ".memory-bank"
            )
            cold_memory_path = os.path.join(memory_bank_dir, "Cold_Memory.md")

            if gc.persistent_summary:
                with open(cold_memory_path, "a", encoding="utf-8") as f:
                    f.write(f"\n\n### Archived Context ({time.strftime('%Y-%m-%d %H:%M:%S')})\n")
                    f.write(gc.persistent_summary)
                logger.info("Persistent summary archived to Cold_Memory.md")

            logger.info("Scheduled Memory GC completed.")
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error("Memory GC loop error", error=str(e))
            await asyncio.sleep(3600)


async def poll_remote_tasks(gateway):
    """Poll for commands from a remote registry (NAT/Firewall-friendly)."""
    poll_url = gateway.config["system"].get("polling_gateway_url")
    if not poll_url:
        logger.info("Polling Gateway: Disabled (no URL in config)")
        return

    interval = gateway.config["system"].get("polling_interval_sec", 30)
    logger.info("Polling Gateway: Active", url=poll_url, interval=interval)

    from src.clawhub.client import ClawHubClient

    client = ClawHubClient(base_url=poll_url, bot_id=str(gateway.admin_id))
    await client.initialize()

    while True:
        try:
            tasks = await client.poll_tasks()
            if isinstance(tasks, list) and tasks:
                for task in tasks:
                    task_hash = hashlib.sha256(task.get("prompt", "").encode()).hexdigest()
                    if task_hash in gateway.processed_task_hashes:
                        continue
                    gateway.processed_task_hashes.add(task_hash)
                    logger.info("Polling Gateway: Received new task", task_hash=task_hash[:8])

                    class MockMessage:
                        def __init__(self, prompt, admin_id, bot):
                            self.text = prompt
                            self.from_user = type("MockUser", (), {"id": admin_id})()
                            self.reply_to_message = None
                            self.bot = bot

                        async def reply(self, text, *args, **kwargs):
                            logger.info("Polling Result", result=text)

                            class MockStatus:
                                async def edit_text(self, *a, **k):
                                    return True

                            return MockStatus()

                        async def answer(self, text, *args, **kwargs):
                            logger.info("Polling Result (Answer)", result=text)

                    from src.handlers.prompt_handler import handle_prompt

                    mock_msg = MockMessage(task.get("prompt"), gateway.admin_id, gateway.bot)
                    asyncio.create_task(handle_prompt(gateway, mock_msg))

            await asyncio.sleep(interval)
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.debug("Polling Gateway Error", error=str(e))
            await asyncio.sleep(interval * 2)
