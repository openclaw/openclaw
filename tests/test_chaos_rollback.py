"""
test_chaos_rollback.py — Forces AutoRollback through controlled filesystem corruption.

Algorithm:
  1. Create checkpoint (clean state).
  2. Inject syntax error into a tracked .py file.
  3. Run validate_files() — expect errors.
  4. Execute rollback() — expect hard reset to checkpoint.
  5. Re-validate — expect zero errors (clean state restored).

WARNING: This test mutates source files and does git resets.
         Marked 'destructive' — excluded from normal CI runs.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from src.core.auto_rollback import AutoRollback


@pytest.mark.destructive
def test_chaos_rollback():
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ar = AutoRollback(repo)
    target = os.path.join(repo, "src", "core", "auto_rollback.py")

    # Save original contents for guaranteed restore
    with open(target, "r", encoding="utf-8") as f:
        original_content = f.read()

    try:
        # Step 1: Clean checkpoint
        sha = ar.create_checkpoint("chaos-test-baseline")
        assert sha, "Checkpoint creation failed"

        # Step 2: Corrupt a file (append broken syntax)
        with open(target, "a") as f:
            f.write("\n\ndef broken_func(:\n    pass  # intentional SyntaxError\n")

        # Step 3: Validate — must detect errors
        errors = ar.validate_files([target])
        assert len(errors) > 0, "Expected compile errors!"

        # Step 4: Rollback
        success = ar.rollback()
        assert success, "Rollback failed!"

        # Step 5: Re-validate — must be clean
        errors_after = ar.validate_files([target])
        assert len(errors_after) == 0, f"Post-rollback errors: {errors_after}"
    finally:
        # Guarantee restore even if rollback mechanism fails
        with open(target, "w", encoding="utf-8") as f:
            f.write(original_content)


if __name__ == "__main__":
    test_chaos_rollback()
