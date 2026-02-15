import unittest


class TestIntegrationApi(unittest.TestCase):
    def test_public_exports(self):
        import integrations as api

        self.assertTrue(callable(api.evaluate_skill))
        self.assertTrue(callable(api.parse_sie_runtime_config))
        self.assertTrue(callable(api.enforce_skill_from_openclaw_config))
        self.assertTrue(callable(api.load_skill_text_with_sie))

    def test_reason_constants_exported(self):
        import integrations as api

        self.assertEqual(api.REASON_SIE_DISABLED, "sie_disabled")
        self.assertEqual(api.REASON_SKILL_NOT_FOUND, "skill_not_found")
        self.assertEqual(api.REASON_UNSIGNED_STRICT, "unsigned_strict")
        self.assertEqual(api.REASON_UNSIGNED_WARN, "unsigned_warn")
        self.assertEqual(api.REASON_VERIFY_FAILED, "verify_failed")
        self.assertEqual(api.REASON_VERIFIED, "verified")


if __name__ == "__main__":
    unittest.main()
