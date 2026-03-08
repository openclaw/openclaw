"""
chaos_test_rollback.py — Forces AutoRollback through controlled filesystem corruption.

Algorithm:
  1. Create checkpoint (clean state).
  2. Inject syntax error into a tracked .py file.
  3. Run validate_files() — expect errors.
  4. Execute rollback() — expect hard reset to checkpoint.
  5. Re-validate — expect zero errors (clean state restored).
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from src.auto_rollback import AutoRollback


def chaos_test():
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ar = AutoRollback(repo)

    # Step 1: Clean checkpoint
    sha = ar.create_checkpoint("chaos-test-baseline")
    print(f"[CHAOS] ✅ Checkpoint: {sha[:8]}")

    # Step 2: Corrupt a file (append broken syntax)
    target = os.path.join(repo, "src", "auto_rollback.py")
    with open(target, "a") as f:
        f.write("\n\ndef broken_func(:\n    pass  # ← intentional SyntaxError\n")
    print("[CHAOS] 💀 Injected SyntaxError into auto_rollback.py")

    # Step 3: Validate — must detect errors
    errors = ar.validate_files([target])
    assert len(errors) > 0, "Expected compile errors!"
    print(f"[CHAOS] ✅ Detected {len(errors)} compile error(s) — as expected")

    # Step 4: Rollback
    success = ar.rollback()
    assert success, "Rollback failed!"
    print("[CHAOS] ✅ Rollback executed successfully")

    # Step 5: Re-validate — must be clean
    errors_after = ar.validate_files([target])
    assert len(errors_after) == 0, f"Post-rollback errors: {errors_after}"
    print("[CHAOS] ✅ Post-rollback validation: CLEAN")
    print("[CHAOS] 🏁 All assertions passed. AutoRollback is battle-ready.")


if __name__ == "__main__":
    chaos_test()
