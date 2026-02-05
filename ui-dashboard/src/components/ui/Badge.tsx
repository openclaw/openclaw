import { ReactNode } from 'react';
import styles from './Badge.module.css';

interface BadgeProps {
  variant?: 'success' | 'warning' | 'error' | 'purple' | 'muted';
  children: ReactNode;
  className?: string;
}

export function Badge({ variant = 'muted', children, className = '' }: BadgeProps) {
  return (
    <span className={`${styles.badge} ${styles[variant]} ${className}`}>
      {children}
    </span>
  );
}
