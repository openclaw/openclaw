"""Tests for the core agent message bus."""

import unittest
import time
from openclaw.messaging.bus import MessageBus


class TestMessageBus(unittest.TestCase):
    """Test suite for MessageBus functionality."""

    def test_publish_subscribe_basic(self):
        """Test basic publish/subscribe functionality."""
        bus = MessageBus()
        received = []

        def handler(msg):
            received.append(msg)

        bus.subscribe("test.topic", handler)
        bus.publish("test.topic", {"key": "value"})

        self.assertEqual(len(received), 1)
        self.assertEqual(received[0], {"key": "value"})

    def test_multiple_subscribers_same_topic(self):
        """Test multiple handlers on the same topic all receive messages."""
        bus = MessageBus()
        received1 = []
        received2 = []

        def handler1(msg):
            received1.append(msg)

        def handler2(msg):
            received2.append(msg)

        bus.subscribe("test.topic", handler1)
        bus.subscribe("test.topic", handler2)
        bus.publish("test.topic", "message")

        self.assertEqual(len(received1), 1)
        self.assertEqual(len(received2), 1)
        self.assertEqual(received1[0], "message")
        self.assertEqual(received2[0], "message")

    def test_subscribers_different_topics(self):
        """Test handlers only receive messages for their subscribed topic."""
        bus = MessageBus()
        received_a = []
        received_b = []

        def handler_a(msg):
            received_a.append(msg)

        def handler_b(msg):
            received_b.append(msg)

        bus.subscribe("topic.a", handler_a)
        bus.subscribe("topic.b", handler_b)
        bus.publish("topic.a", "msg_a")
        bus.publish("topic.b", "msg_b")
        bus.publish("topic.a", "msg_a2")

        self.assertEqual(received_a, ["msg_a", "msg_a2"])
        self.assertEqual(received_b, ["msg_b"])

    def test_handler_exception_routed_to_dead_letter(self):
        """Test that messages from failing handlers go to dead-letter queue."""
        bus = MessageBus()

        def bad_handler(msg):
            raise ValueError("handler error")

        def good_handler(msg):
            pass

        bus.subscribe("test.topic", bad_handler)
        bus.subscribe("test.topic", good_handler)
        bus.publish("test.topic", "problematic")

        # Good handler should have run without issue
        # Dead letter queue should contain the problematic message
        dlq = bus.get_dead_letter_queue()
        self.assertEqual(len(dlq), 1)
        dlq_msg, error, handler_ref = dlq[0]
        self.assertEqual(dlq_msg, "problematic")
        self.assertIsInstance(error, ValueError)
        self.assertEqual(str(error), "handler error")

    def test_dead_letter_queue_is_per_topic(self):
        """Test that dead-letter queue isolates messages by topic."""
        bus = MessageBus()

        def bad_a(msg):
            if msg == "fail":
                raise RuntimeError("fail a")

        def bad_b(msg):
            if msg == "fail":
                raise ValueError("fail b")

        bus.subscribe("topic.a", bad_a)
        bus.subscribe("topic.b", bad_b)

        bus.publish("topic.a", "fail")
        bus.publish("topic.b", "fail")

        dlq_a = bus.get_dead_letter_queue("topic.a")
        dlq_b = bus.get_dead_letter_queue("topic.b")

        self.assertEqual(len(dlq_a), 1)
        self.assertEqual(len(dlq_b), 1)
        self.assertEqual(dlq_a[0][0], "fail")
        self.assertIsInstance(dlq_a[0][1], RuntimeError)
        self.assertIsInstance(dlq_b[0][1], ValueError)
        self.assertEqual(str(dlq_b[0][1]), "fail b")

    def test_message_order_preserved(self):
        """Test that messages are delivered in publish order."""
        bus = MessageBus()
        order = []

        def handler(msg):
            order.append(msg)

        bus.subscribe("test", handler)
        for i in range(10):
            bus.publish("test", i)

        self.assertEqual(order, list(range(10)))

    def test_handler_can_publish_during_handling(self):
        """Test that handlers can publish new messages during execution."""
        bus = MessageBus()
        received = []

        def handler1(msg):
            received.append(("handler1", msg))
            if msg == "trigger":
                bus.publish("other.topic", "from_handler1")

        def handler2(msg):
            received.append(("handler2", msg))

        bus.subscribe("main.topic", handler1)
        bus.subscribe("other.topic", handler2)
        bus.publish("main.topic", "trigger")

        self.assertIn(("handler1", "trigger"), received)
        self.assertIn(("handler2", "from_handler1"), received)

    def test_subscribe_returns_unsubscribe_function(self):
        """Test that subscribe returns an unsubscribe function."""
        bus = MessageBus()
        received = []

        def handler(msg):
            received.append(msg)

        unsubscribe = bus.subscribe("test", handler)
        bus.publish("test", "first")
        unsubscribe()
        bus.publish("test", "second")

        self.assertEqual(received, ["first"])

    def test_unsubscribe_multiple(self):
        """Test unsubscribing multiple handlers works independently."""
        bus = MessageBus()
        received1 = []
        received2 = []

        def handler1(msg):
            received1.append(msg)

        def handler2(msg):
            received2.append(msg)

        unsub1 = bus.subscribe("topic", handler1)
        unsub2 = bus.subscribe("topic", handler2)

        bus.publish("topic", "msg1")
        unsub1()
        bus.publish("topic", "msg2")
        unsub2()
        bus.publish("topic", "msg3")

        self.assertEqual(received1, ["msg1"])
        self.assertEqual(received2, ["msg1", "msg2"])

    def test_dead_letter_queue_limit(self):
        """Test that dead-letter queue has a configurable limit."""
        bus = MessageBus(max_dlq_size=5)

        def bad_handler(msg):
            raise ValueError("error")

        bus.subscribe("topic", bad_handler)

        # Publish more than the limit
        for i in range(10):
            bus.publish("topic", f"msg{i}")

        dlq = bus.get_dead_letter_queue()
        self.assertEqual(len(dlq), 5)
        # Should contain the last 5 messages
        for i, (msg, err, _) in enumerate(dlq):
            self.assertEqual(msg, f"msg{i+5}")

    def test_clear_dead_letter_queue(self):
        """Test clearing the dead-letter queue."""
        bus = MessageBus()

        def bad_handler(msg):
            raise ValueError("error")

        bus.subscribe("topic", bad_handler)
        bus.publish("topic", "msg1")
        bus.publish("topic", "msg2")

        self.assertEqual(len(bus.get_dead_letter_queue()), 2)
        bus.clear_dead_letter_queue()
        self.assertEqual(len(bus.get_dead_letter_queue()), 0)

    def test_high_throughput_basic(self):
        """Test that the bus can handle at least 100 msg/sec for a simple case."""
        bus = MessageBus()
        received = []

        def handler(msg):
            received.append(msg)

        bus.subscribe("test", handler)

        start = time.time()
        num_messages = 500  # more than 100
        for i in range(num_messages):
            bus.publish("test", i)
        elapsed = time.time() - start

        # All messages should be delivered
        self.assertEqual(len(received), num_messages)
        # Throughput should be at least 100 msg/sec
        rate = num_messages / elapsed
        self.assertGreaterEqual(rate, 100, f"Throughput {rate} < 100 msg/sec")


if __name__ == "__main__":
    unittest.main()
